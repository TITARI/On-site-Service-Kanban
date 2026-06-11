import { describe, expect, it } from "vitest";
import { createFileAppRepository } from "@/lib/repositories/app-repository";
import type { AppState } from "@/lib/domain/app-state";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import { verifyPassword } from "@/lib/services/password-service";

const groups: UserGroup[] = [
  {
    id: "ops",
    name: "Operations",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "review",
    name: "Review",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: true,
    canAdmin: false,
    enabled: true
  },
  {
    id: "admin",
    name: "Administrators",
    description: "",
    canClaim: false,
    canProcess: false,
    canAccept: false,
    canAdmin: true,
    enabled: true
  }
];

function accessState(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    accounts: [],
    accountCredentials: [],
    roles: [],
    accountRoles: [],
    rolePermissions: [],
    accountSessions: [],
    auditLogs: [],
    authBootstrap: {},
    config: {
      ...defaultConfig(),
      userGroups: structuredClone(groups)
    }
  };
}

function memoryStore(initial = accessState(), withAtomicUpdate = true) {
  let current = structuredClone(initial);
  const store = {
    readState: async () => {
      await Promise.resolve();
      return structuredClone(current);
    },
    writeState: async (state: AppState) => {
      await Promise.resolve();
      current = structuredClone(state);
    },
    updateState: withAtomicUpdate
      ? async <T>(operation: (state: AppState) => Promise<T> | T) => {
          const draft = structuredClone(current);
          const result = await operation(draft);
          current = draft;
          return result;
        }
      : undefined,
    snapshot: () => structuredClone(current)
  };
  return store;
}

async function createMobile(repository: ReturnType<typeof createFileAppRepository>) {
  return repository.upsertMobileAccount({
    name: "Alice",
    phone: "138 0013-8000",
    groupId: "ops"
  });
}

describe("file access repository", () => {
  it("creates stable mobile identities, inherits role permissions, and preserves a locked group", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    const first = await createMobile(repository);
    const firstState = store.snapshot();
    const person = firstState.people?.[0];
    const account = firstState.accounts?.[0];

    expect(first.actor).toMatchObject({
      name: "Alice",
      phone: "13800138000",
      groupId: "ops",
      permissions: ["ticket.claim", "ticket.process"],
      sessionType: "mobile"
    });
    expect(person?.id).toMatch(/^person-/);
    expect(account?.id).toMatch(/^account-/);
    expect(person?.id).not.toContain("13800138000");
    expect(account?.id).not.toContain("13800138000");
    expect(firstState.accountRoles).toEqual([
      expect.objectContaining({ accountId: account?.id, roleId: "role-ops" })
    ]);

    if (!person) throw new Error("person was not created");
    person.groupLocked = true;
    await store.updateState?.((state) => {
      state.people = [person];
    });

    const second = await repository.upsertMobileAccount({
      name: "Alice Updated",
      phone: "13800138000",
      groupId: "review"
    });

    expect(second.actor).toMatchObject({
      name: "Alice Updated",
      groupId: "ops"
    });
    expect(store.snapshot().people).toHaveLength(1);
    expect(store.snapshot().accounts).toHaveLength(1);
  });

  it("derives actors only through account roles and role permissions", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const expiresAt = new Date(Date.now() + 60_000);
    await repository.createAccountSession(actor.accountId, "mobile", "hash-only", expiresAt);

    await store.updateState?.((state) => {
      state.rolePermissions = [];
    });

    await expect(repository.resolveAccountSession("hash-only", "mobile")).resolves.toMatchObject({
      actor: {
        permissions: []
      }
    });
  });

  it("validates session type, expiry, revocation, auth version, and enabled access chain", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const future = new Date(Date.now() + 60_000);

    const active = await repository.createAccountSession(actor.accountId, "mobile", "active-hash", future);
    expect(active.tokenHash).toBe("active-hash");
    await expect(repository.resolveAccountSession("active-hash", "mobile")).resolves.toMatchObject({
      actor: { accountId: actor.accountId },
      session: { id: active.id }
    });
    await expect(repository.resolveAccountSession("active-hash", "admin")).resolves.toBeUndefined();

    await repository.createAccountSession(actor.accountId, "mobile", "expired-hash", new Date(Date.now() - 1));
    await expect(repository.resolveAccountSession("expired-hash", "mobile")).resolves.toBeUndefined();

    await repository.revokeAccountSession("active-hash");
    await expect(repository.resolveAccountSession("active-hash", "mobile")).resolves.toBeUndefined();
    expect(store.snapshot().accountSessions?.find((session) => session.id === active.id)?.revokedAt).toBeTruthy();

    await repository.createAccountSession(actor.accountId, "mobile", "version-hash", future);
    await repository.revokeAccountSessions(actor.accountId);
    await expect(repository.resolveAccountSession("version-hash", "mobile")).resolves.toBeUndefined();

    const next = await repository.createAccountSession(actor.accountId, "mobile", "disabled-hash", future);
    await store.updateState?.((state) => {
      const account = state.accounts?.find((item) => item.id === actor.accountId);
      if (account) account.enabled = false;
    });
    await expect(repository.resolveAccountSession(next.tokenHash, "mobile")).resolves.toBeUndefined();
  });

  it("invalidates sessions for phone, group, enabled, and password changes but not name-only updates", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const future = new Date(Date.now() + 60_000);

    await repository.createAccountSession(actor.accountId, "mobile", "name-hash", future);
    await repository.updateUser(actor.personId, { name: "Alice Renamed" }, actor);
    await expect(repository.resolveAccountSession("name-hash", "mobile")).resolves.toBeDefined();

    for (const [token, mutation] of [
      ["phone-hash", { phone: "13900139000" }],
      ["group-hash", { groupId: "review" }],
      ["enabled-hash", { enabled: false }]
    ] as const) {
      const current = await repository.getUser(actor.personId);
      if (!current) throw new Error("user missing");
      if (mutation.enabled === false) {
        await repository.updateUser(actor.personId, { enabled: true }, actor);
      }
      await repository.createAccountSession(current.accountId, "mobile", token, future);
      await repository.updateUser(actor.personId, mutation, actor);
      await expect(repository.resolveAccountSession(token, "mobile")).resolves.toBeUndefined();
    }

    await repository.setUserEnabled(actor.personId, true, actor);
    const current = await repository.getUser(actor.personId);
    if (!current) throw new Error("user missing");
    await repository.createAccountSession(current.accountId, "mobile", "password-hash", future);
    await repository.setUserPassword(actor.personId, "scrypt$already-hashed", actor);
    await expect(repository.resolveAccountSession("password-hash", "mobile")).resolves.toBeUndefined();
  });

  it("revokes active sessions immediately when synced role permissions change", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "permission-hash",
      new Date(Date.now() + 60_000)
    );

    await repository.syncAccessRoles(groups.map((group) => (
      group.id === "ops" ? { ...group, canClaim: false, canProcess: false } : group
    )), actor);

    await expect(repository.resolveAccountSession("permission-hash", "mobile")).resolves.toBeUndefined();
    const refreshed = await repository.upsertMobileAccount({
      name: "Alice",
      phone: "13800138000",
      groupId: "ops"
    });
    expect(refreshed.actor.permissions).toEqual([]);
  });

  it("serializes fallback mutations for the same account", async () => {
    const store = memoryStore(accessState(), false);
    const repository = createFileAppRepository(store);
    const secondRepository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.setUserPassword(actor.personId, "scrypt$stored-hash", actor);

    await Promise.all([
      repository.recordAdminLoginFailure(actor.accountId),
      secondRepository.recordAdminLoginFailure(actor.accountId)
    ]);

    expect(store.snapshot().accountCredentials?.find((item) => item.accountId === actor.accountId)?.failedAttempts).toBe(2);
  });

  it("supports bootstrap, user queries, CRUD, credentials, bindings, and secret-safe audit logs", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    await expect(repository.bootstrapStatus()).resolves.toEqual({ required: true });
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    await expect(repository.bootstrapStatus()).resolves.toEqual({ required: false });
    await expect(repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Second Root",
      phone: "13600136000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toThrow(/bootstrap|初始化/i);

    expect(admin.permissions).toContain("admin.access");
    const adminRecord = await repository.adminLoginRecord("137 0013 7000");
    expect(adminRecord?.credential.passwordHash).not.toBe("StrongPass123!");
    await expect(verifyPassword("StrongPass123!", adminRecord?.credential.passwordHash ?? "")).resolves.toBe(true);

    const created = await repository.createUser({
      name: "Bound Operator",
      phone: "13800138000",
      groupId: "ops",
      groupLocked: false,
      enabled: true
    }, admin);
    await store.updateState?.((state) => {
      state.chatIdentities?.push({
        id: "identity-1",
        platform: "wechat",
        externalUserId: "wx-1",
        displayName: "Bound Operator",
        personId: created.personId,
        firstSeenAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      });
    });

    await expect(repository.getUser(created.personId)).resolves.toMatchObject({
      name: "Bound Operator",
      permissions: ["ticket.claim", "ticket.process"],
      hasPassword: false,
      identities: {
        wechat: { externalUserId: "wx-1" }
      }
    });
    await expect(repository.listUsers({
      search: "1380013",
      groupId: "ops",
      enabled: true,
      admin: false,
      binding: "bound",
      page: 1,
      pageSize: 10
    })).resolves.toMatchObject({
      total: 1,
      users: [expect.objectContaining({ personId: created.personId })]
    });

    await repository.updateUser(created.personId, { name: "Updated Operator", groupLocked: true }, admin);
    await repository.setUserEnabled(created.personId, false, admin);
    await repository.setUserEnabled(created.personId, true, admin);
    await repository.setUserPassword(created.personId, "scrypt$stored-hash", admin);
    const lockedUntil = new Date(Date.now() + 60_000);
    await repository.recordAdminLoginFailure(admin.accountId, lockedUntil);
    await repository.recordAdminLoginFailure(admin.accountId);
    expect((await repository.adminLoginRecord(admin.phone))?.credential).toMatchObject({
      failedAttempts: 2,
      lockedUntil: lockedUntil.toISOString()
    });
    await repository.recordAdminLoginSuccess(admin.accountId);
    expect((await repository.adminLoginRecord(admin.phone))?.credential).toMatchObject({
      failedAttempts: 0,
      lockedUntil: undefined
    });

    const serializedAudit = JSON.stringify(store.snapshot().auditLogs);
    expect(serializedAudit).not.toContain("legacy-secret");
    expect(serializedAudit).not.toContain("StrongPass123!");
    expect(serializedAudit).not.toContain("scrypt$stored-hash");
    expect(serializedAudit).not.toContain("hash-only");
    expect(store.snapshot().auditLogs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actorId: admin.accountId,
        actorName: admin.name,
        targetType: "user",
        detail: expect.any(Object)
      })
    ]));

    await repository.deleteUser(created.personId, admin);
    await expect(repository.getUser(created.personId)).resolves.toBeUndefined();
    expect(store.snapshot().accounts?.some((account) => account.id === created.accountId)).toBe(false);
    expect(store.snapshot().accountRoles?.some((item) => item.accountId === created.accountId)).toBe(false);
    expect(store.snapshot().accountCredentials?.some((item) => item.accountId === created.accountId)).toBe(false);
  });

  it("rejects invalid Chinese mobile numbers, disabled users, and disabled groups", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    await expect(repository.upsertMobileAccount({
      name: "Invalid",
      phone: "12345",
      groupId: "ops"
    })).rejects.toThrow(/手机号|mobile|phone/i);

    await store.updateState?.((state) => {
      const group = state.config.userGroups?.find((item) => item.id === "review");
      if (group) group.enabled = false;
    });
    await expect(repository.upsertMobileAccount({
      name: "Disabled Group",
      phone: "13800138001",
      groupId: "review"
    })).rejects.toThrow(/分组|group/i);

    const { actor } = await createMobile(repository);
    await repository.setUserEnabled(actor.personId, false, actor);
    await expect(createMobile(repository)).rejects.toThrow(/禁用|disabled/i);
  });
});
