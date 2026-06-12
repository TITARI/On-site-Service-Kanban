import { describe, expect, it } from "vitest";
import { createFileAppRepository } from "@/lib/repositories/app-repository";
import type { AppState } from "@/lib/domain/app-state";
import type { UserGroup } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import { verifyPassword } from "@/lib/services/password-service";
import { recordAdminLoginFailureInState } from "@/lib/services/access-state-service";

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
    await repository.updateUser(person.id, { groupLocked: true }, first.actor);

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
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
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
    const future = new Date(Date.now() + 60_000).toISOString();

    const active = await repository.createAccountSession(actor.accountId, "mobile", "active-hash", future);
    expect(active.tokenHash).toBe("active-hash");
    await expect(repository.resolveAccountSession("active-hash", "mobile")).resolves.toMatchObject({
      actor: { accountId: actor.accountId },
      session: { id: active.id }
    });
    await expect(repository.resolveAccountSession("active-hash", "admin")).resolves.toBeUndefined();

    await expect(repository.createAccountSession(
      actor.accountId,
      "mobile",
      "expired-hash",
      new Date(Date.now() - 1).toISOString()
    )).rejects.toThrow(/future|expired|未来|过期/i);
    await expect(repository.createAccountSession(
      actor.accountId,
      "mobile",
      "invalid-date-hash",
      "not-a-date"
    )).rejects.toThrow(/date|ISO|日期/i);

    const auditCountBeforeSingleRevoke = store.snapshot().auditLogs?.length ?? 0;
    await repository.revokeAccountSession("active-hash");
    await expect(repository.resolveAccountSession("active-hash", "mobile")).resolves.toBeUndefined();
    expect(store.snapshot().accountSessions?.find((session) => session.id === active.id)?.revokedAt).toBeTruthy();
    expect(store.snapshot().auditLogs).toHaveLength(auditCountBeforeSingleRevoke + 1);
    expect(store.snapshot().auditLogs?.at(-1)).toMatchObject({
      actorName: "system",
      action: "session.revoke",
      targetType: "session",
      targetId: active.id,
      detail: {
        accountId: actor.accountId,
        sessionId: active.id,
        sessionType: "mobile"
      }
    });
    const auditCountBeforeNoop = store.snapshot().auditLogs?.length ?? 0;
    await repository.revokeAccountSession("missing-token-hash");
    expect(store.snapshot().auditLogs).toHaveLength(auditCountBeforeNoop);

    await repository.createAccountSession(actor.accountId, "mobile", "version-hash", future);
    const authVersionBeforeRevokeAll = store.snapshot().accounts?.[0]?.authVersion;
    await repository.revokeAccountSessions(actor.accountId);
    await expect(repository.resolveAccountSession("version-hash", "mobile")).resolves.toBeUndefined();
    expect(store.snapshot().accounts?.[0]?.authVersion).toBe((authVersionBeforeRevokeAll ?? 0) + 1);
    expect(store.snapshot().auditLogs?.at(-1)).toMatchObject({
      actorName: "system",
      action: "sessions.revoke",
      targetType: "account",
      targetId: actor.accountId,
      detail: {
        accountId: actor.accountId,
        revokedCount: 1
      }
    });
    expect(JSON.stringify(store.snapshot().auditLogs)).not.toContain("active-hash");
    expect(JSON.stringify(store.snapshot().auditLogs)).not.toContain("missing-token-hash");
    expect(JSON.stringify(store.snapshot().auditLogs)).not.toContain("version-hash");

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
    const future = new Date(Date.now() + 60_000).toISOString();

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
    await repository.createAccountSession(current.accountId, "mobile", "group-lock-hash", future);
    await repository.updateUser(actor.personId, { groupLocked: true }, actor);
    await expect(repository.resolveAccountSession("group-lock-hash", "mobile")).resolves.toBeUndefined();

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
      new Date(Date.now() + 60_000).toISOString()
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

  it("syncs access roles atomically when saveConfig changes user groups", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    await repository.createAccountSession(actor.accountId, "mobile", "config-permission-hash", expiresAt);
    const authVersionBeforePermissionChange = store.snapshot().accounts?.[0]?.authVersion;

    await repository.saveConfig({
      ...store.snapshot().config,
      userGroups: groups.map((group) => (
        group.id === "ops" ? { ...group, canClaim: false, canProcess: false } : group
      ))
    });

    await expect(repository.resolveAccountSession("config-permission-hash", "mobile")).resolves.toBeUndefined();
    expect(store.snapshot().accounts?.[0]?.authVersion).toBe((authVersionBeforePermissionChange ?? 0) + 1);
    const refreshed = await createMobile(repository);
    expect(refreshed.actor.permissions).toEqual([]);

    await repository.createAccountSession(actor.accountId, "mobile", "keyword-only-hash", expiresAt);
    const authVersionBeforeKeywordChange = store.snapshot().accounts?.[0]?.authVersion;
    await repository.saveConfig({
      ...store.snapshot().config,
      keywordGroups: [{
        id: "test-keywords",
        name: "Test keywords",
        description: "",
        enabled: true,
        rules: []
      }]
    });

    await expect(repository.resolveAccountSession("keyword-only-hash", "mobile")).resolves.toBeDefined();
    expect(store.snapshot().accounts?.[0]?.authVersion).toBe(authVersionBeforeKeywordChange);
  });

  it("keeps immutable ids when a phone changes and permits the old phone to be reused", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const first = await createMobile(repository);
    const originalPersonId = first.actor.personId;
    const originalAccountId = first.actor.accountId;

    const updated = await repository.updateUser(originalPersonId, {
      phone: "13900139000"
    }, first.actor);
    const replacement = await repository.createUser({
      name: "Replacement",
      phone: "13800138000",
      groupId: "review",
      groupLocked: false,
      enabled: true
    }, first.actor);

    expect(updated).toMatchObject({
      personId: originalPersonId,
      accountId: originalAccountId,
      phone: "13900139000"
    });
    expect(replacement.personId).not.toBe(originalPersonId);
    expect(replacement.accountId).not.toBe(originalAccountId);
    expect(store.snapshot().accountRoles).toEqual(expect.arrayContaining([
      expect.objectContaining({ accountId: originalAccountId, roleId: "role-ops" }),
      expect.objectContaining({ accountId: replacement.accountId, roleId: "role-review" })
    ]));
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

  it("validates lock timestamps before mutating credentials", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    const state = store.snapshot();

    expect(() => recordAdminLoginFailureInState(state, admin.accountId, "not-a-date")).toThrow(/date|ISO/i);
    expect(state.accountCredentials?.find((item) => item.accountId === admin.accountId)?.failedAttempts).toBe(0);
  });

  it("supports bootstrap, user queries, CRUD, credentials, bindings, and secret-safe audit logs", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    await expect(repository.bootstrapStatus()).resolves.toEqual({ required: true });
    const admin = await repository.bootstrapAdmin(
      {
        legacyPassword: "legacy-secret",
        name: "Root Admin",
        phone: "13700137000",
        password: "StrongPass123!",
        group: { mode: "existing", groupId: "admin" }
      },
      {
        sessionType: "admin",
        tokenHash: "bootstrap-session-hash",
        expiresAt: "2099-01-01T00:00:00.000Z"
      }
    );
    await expect(repository.bootstrapStatus()).resolves.toEqual({ required: false });
    await expect(repository.resolveAccountSession(
      "bootstrap-session-hash",
      "admin"
    )).resolves.toMatchObject({
      actor: { accountId: admin.accountId, sessionType: "admin" },
      session: { accountId: admin.accountId, sessionType: "admin" }
    });
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
    const lockedUntil = new Date(Date.now() + 60_000).toISOString();
    await repository.recordAdminLoginFailure(admin.accountId, lockedUntil);
    await repository.recordAdminLoginFailure(admin.accountId);
    expect((await repository.adminLoginRecord(admin.phone))?.credential).toMatchObject({
      failedAttempts: 2,
      lockedUntil
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

  it("rejects group changes that remove the final usable administrator", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(repository.saveConfig({
      ...store.snapshot().config,
      userGroups: groups.map((group) => ({ ...group, canAdmin: false }))
    })).rejects.toThrow("必须保留至少一位可用后台管理员");

    expect(store.snapshot().config.userGroups?.find((group) => group.id === "admin")?.canAdmin).toBe(true);
  });

  it("detects business history but ignores audits where the user is only the target", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    const created = await repository.createUser({
      name: "Alice",
      phone: "13800138000",
      groupId: "ops",
      groupLocked: false,
      enabled: true
    }, admin);
    await store.updateState?.((state) => {
      state.auditLogs?.push({
        id: "audit-target-only",
        actorId: "account-other",
        actorName: "Other Admin",
        action: "user.update",
        targetType: "user",
        targetId: created.personId,
        detail: {},
        createdAt: "2026-06-12T00:00:00.000Z"
      });
    });

    await expect(repository.userDeletionHistory(created.personId)).resolves.toEqual({
      deletable: true,
      reasons: []
    });

    await store.updateState?.((state) => {
      state.messageRecords.push({
        id: "message-history",
        channel: "wechat",
        senderName: "Alice",
        text: "A01 needs help",
        imageUrls: [],
        receivedAt: "2026-06-12T00:00:00.000Z",
        createdAt: "2026-06-12T00:00:00.000Z",
        reporterPersonId: created.personId,
        analysis: {
          confidence: 1,
          suggestedAction: "create-ticket",
          reason: "matched"
        }
      });
    });

    await expect(repository.userDeletionHistory(created.personId)).resolves.toEqual({
      deletable: false,
      reasons: ["inboundMessages"]
    });
    await expect(repository.deleteUser(created.personId, admin)).rejects.toThrow("该用户已有历史记录，仅可停用");
  });

  it("blocks direct disable and delete calls for the final usable administrator", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(repository.usableAdminCount()).resolves.toBe(1);
    await expect(repository.setUserEnabled(admin.personId, false, admin)).rejects.toThrow(
      "必须保留至少一位可用后台管理员"
    );
    await expect(repository.deleteUser(admin.personId, admin)).rejects.toThrow(
      "必须保留至少一位可用后台管理员"
    );
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
