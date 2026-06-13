import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type {
  AuthenticatedActor,
  UserMutation
} from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";
import { createFileAppRepository } from "@/lib/repositories/app-repository";
import { verifyPassword } from "@/lib/services/password-service";
import { defaultConfig } from "@/lib/seed";

type AccessAuditLogEntry = {
  id: string;
  actorId?: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
};

type AccessTestState = AppState & {
  auditLogs?: AccessAuditLogEntry[];
};

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "Builder",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "business",
    name: "Business",
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

function accessState(): AccessTestState {
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
    authBootstrap: null,
    config: {
      ...defaultConfig(),
      userGroups: structuredClone(groups)
    }
  };
}

function memoryStore(initial = accessState(), atomic = true) {
  let current = structuredClone(initial);
  const store = {
    readState: async () => structuredClone(current) as AppState,
    writeState: async (state: AppState) => {
      current = structuredClone(state) as AccessTestState;
    },
    updateState: atomic
      ? async <T>(operation: (state: AppState) => Promise<T> | T) => {
          const draft = structuredClone(current);
          const result = await operation(draft);
          current = draft;
          return result;
        }
      : undefined,
    mutate: (operation: (state: AccessTestState) => void) => {
      operation(current);
    },
    snapshot: () => structuredClone(current)
  };
  return store;
}

function adminActor(): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin"
  };
}

async function createMobile(
  repository: ReturnType<typeof createFileAppRepository>,
  groupId = "builder"
) {
  return repository.upsertMobileAccount({
    name: "Alice",
    phone: "138 0013-8000",
    groupId
  });
}

describe("file access repository", () => {
  it("normalizes mobile accounts, keeps stable ids, and respects admin group locks", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);

    const first = await createMobile(repository);
    const firstSnapshot = store.snapshot();
    const firstPersonId = first.actor.personId;
    const firstAccountId = first.actor.accountId;

    expect(first.actor).toMatchObject({
      phone: "13800138000",
      groupId: "builder",
      permissions: ["ticket.claim", "ticket.process"],
      sessionType: "mobile"
    });
    expect(firstPersonId).toBe(
      "person-ppQvl3HWfzQDTS8ZJpiO0_rTvxtOfO25ox8xOY3qQ7w"
    );
    expect(firstAccountId).toBe(`account-${firstPersonId}`);
    expect(firstSnapshot.accountRoles).toEqual([
      expect.objectContaining({
        accountId: firstAccountId,
        roleId: "role-builder"
      })
    ]);

    const moved = await repository.upsertMobileAccount({
      name: "Alice Updated",
      phone: "13800138000",
      groupId: "business"
    });
    expect(moved.actor).toMatchObject({
      personId: firstPersonId,
      accountId: firstAccountId,
      groupId: "business"
    });
    expect(store.snapshot().people).toHaveLength(1);
    expect(store.snapshot().accounts).toHaveLength(1);

    await repository.updateUser(
      firstPersonId,
      { groupId: "builder", groupLocked: true },
      adminActor()
    );
    const locked = await repository.upsertMobileAccount({
      name: "Alice Final",
      phone: "13800138000",
      groupId: "business"
    });

    expect(locked.actor).toMatchObject({
      personId: firstPersonId,
      accountId: firstAccountId,
      groupId: "builder"
    });
    expect(store.snapshot().accountRoles?.filter(
      (link) => link.accountId === firstAccountId
    )).toHaveLength(1);
  });

  it("derives actors only from persisted account-role-permission links", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "persisted-token-hash",
      "2099-01-01T00:00:00.000Z"
    );

    store.mutate((state) => {
      const builder = state.config.userGroups?.find(
        (group) => group.id === "builder"
      );
      if (builder) {
        builder.canClaim = false;
        builder.canProcess = false;
        builder.canAdmin = true;
      }
    });

    await expect(
      repository.resolveAccountSession("persisted-token-hash", "mobile")
    ).resolves.toMatchObject({
      actor: {
        permissions: ["ticket.claim", "ticket.process"]
      }
    });

    store.mutate((state) => {
      state.rolePermissions = [];
    });
    await expect(
      repository.resolveAccountSession("persisted-token-hash", "mobile")
    ).resolves.toMatchObject({
      actor: { permissions: [] }
    });
  });

  it("stores hash-only sessions and validates type, expiry, revocation, and auth version", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    const session = await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "hash-only-value",
      "2099-01-01T00:00:00.000Z"
    );

    expect(session).toMatchObject({
      accountId: actor.accountId,
      sessionType: "mobile",
      tokenHash: "hash-only-value",
      authVersion: 1
    });
    expect(JSON.stringify(store.snapshot())).not.toContain("raw-session-token");
    await expect(
      repository.resolveAccountSession("hash-only-value", "mobile")
    ).resolves.toMatchObject({
      session: { id: session.id },
      actor: { accountId: actor.accountId }
    });
    await expect(
      repository.resolveAccountSession("hash-only-value", "admin")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const stored = state.accountSessions?.find(
        (item) => item.id === session.id
      );
      if (stored) stored.expiresAt = "2000-01-01T00:00:00.000Z";
    });
    await expect(
      repository.resolveAccountSession("hash-only-value", "mobile")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const stored = state.accountSessions?.find(
        (item) => item.id === session.id
      );
      if (stored) stored.expiresAt = "2099-01-01T00:00:00.000Z";
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.authVersion += 1;
    });
    await expect(
      repository.resolveAccountSession("hash-only-value", "mobile")
    ).resolves.toBeUndefined();
  });

  it("rejects sessions independently when the account or person is disabled", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "enabled-chain-hash",
      "2099-01-01T00:00:00.000Z"
    );

    await expect(
      repository.resolveAccountSession("enabled-chain-hash", "mobile")
    ).resolves.toBeDefined();

    store.mutate((state) => {
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.enabled = false;
    });
    await expect(
      repository.resolveAccountSession("enabled-chain-hash", "mobile")
    ).resolves.toBeUndefined();

    store.mutate((state) => {
      const account = state.accounts?.find(
        (item) => item.id === actor.accountId
      );
      if (account) account.enabled = true;
    });
    await expect(
      repository.resolveAccountSession("enabled-chain-hash", "mobile")
    ).resolves.toBeDefined();

    store.mutate((state) => {
      const person = state.people?.find(
        (item) => item.id === actor.personId
      );
      if (person) person.enabled = false;
    });
    expect(store.snapshot().accounts?.find(
      (item) => item.id === actor.accountId
    )?.enabled).toBe(true);
    await expect(
      repository.resolveAccountSession("enabled-chain-hash", "mobile")
    ).resolves.toBeUndefined();
  });

  it("revokes one or all sessions and keeps record versions coherent", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "first-hash",
      "2099-01-01T00:00:00.000Z"
    );
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "second-hash",
      "2099-01-01T00:00:00.000Z"
    );

    await repository.revokeAccountSession("first-hash");
    await expect(
      repository.resolveAccountSession("first-hash", "mobile")
    ).resolves.toBeUndefined();
    await expect(
      repository.resolveAccountSession("second-hash", "mobile")
    ).resolves.toBeDefined();

    const before = store.snapshot().accounts?.[0]?.authVersion ?? 0;
    await repository.revokeAccountSessions(actor.accountId);
    const snapshot = store.snapshot();

    expect(snapshot.accounts?.[0]?.authVersion).toBe(before + 1);
    expect(snapshot.accountSessions?.filter(
      (item) => item.accountId === actor.accountId
    ).every((item) => Boolean(item.revokedAt))).toBe(true);
    expect(snapshot.accountSessions?.filter(
      (item) => item.accountId === actor.accountId
    ).every((item) => item.authVersion === before)).toBe(true);
    await expect(
      repository.resolveAccountSession("second-hash", "mobile")
    ).resolves.toBeUndefined();
  });

  it("handles admin login records, lock counters, and successful login state", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const admin = await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "137 0013-7000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    await expect(
      repository.adminLoginRecord("13700137000")
    ).resolves.toMatchObject({
      actor: { accountId: admin.accountId },
      credential: { failedAttempts: 0 }
    });

    store.mutate((state) => {
      state.accountCredentials = [];
    });
    await expect(
      repository.adminLoginRecord("13700137000")
    ).resolves.toBeUndefined();

    await repository.setUserPassword(
      admin.personId,
      "scrypt$stored-hash",
      admin
    );
    const lockedUntil = "2099-01-01T00:00:00.000Z";
    await repository.recordAdminLoginFailure(admin.accountId, lockedUntil);
    await repository.recordAdminLoginFailure(admin.accountId);
    await expect(
      repository.adminLoginRecord("137 0013 7000")
    ).resolves.toMatchObject({
      credential: {
        failedAttempts: 2,
        lockedUntil
      }
    });

    await repository.recordAdminLoginSuccess(admin.accountId);
    const record = await repository.adminLoginRecord("13700137000");
    expect(record?.credential).toMatchObject({
      failedAttempts: 0,
      lockedUntil: undefined
    });
    expect(record?.actor).toMatchObject({ accountId: admin.accountId });
    expect(store.snapshot().accounts?.[0]?.lastLoginAt).toBeTruthy();
  });

  it("bootstraps once with existing or new admin groups and never persists plaintext secrets", async () => {
    const existingStore = memoryStore();
    const existingRepository = createFileAppRepository(existingStore);

    await expect(existingRepository.bootstrapStatus()).resolves.toEqual({
      required: true
    });
    await expect(existingRepository.bootstrapAdmin({
      legacyPassword: "",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toThrow(/legacy/i);

    const admin = await existingRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });
    expect(admin.accountId).toBe(`account-${admin.personId}`);

    await expect(existingRepository.bootstrapStatus()).resolves.toEqual({
      required: false
    });
    await expect(existingRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Second Admin",
      phone: "13600136000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    })).rejects.toThrow(/bootstrap|initial/i);

    const stored = existingStore.snapshot();
    const credential = stored.accountCredentials?.find(
      (item) => item.accountId === admin.accountId
    );
    expect(credential?.passwordHash).not.toBe("StrongPass123!");
    await expect(
      verifyPassword("StrongPass123!", credential?.passwordHash ?? "")
    ).resolves.toBe(true);
    expect(JSON.stringify(stored.auditLogs)).not.toContain("legacy-secret");
    expect(JSON.stringify(stored.auditLogs)).not.toContain("StrongPass123!");

    const createStore = memoryStore();
    const createRepository = createFileAppRepository(createStore);
    const created = await createRepository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Created Admin",
      phone: "13600136000",
      password: "StrongPass123!",
      group: { mode: "create", name: "New Admin Group" }
    });
    expect(created.accountId).toBe(`account-${created.personId}`);
    expect(created.permissions).toContain("admin.access");
    expect(createStore.snapshot().config.userGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "New Admin Group",
          canAdmin: true,
          enabled: true
        })
      ])
    );
  });

  it("supports user CRUD, filters, pagination, auth invalidation, and secret-safe audits", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const actor = adminActor();
    const inputs: UserMutation[] = [
      {
        name: "Alice Builder",
        phone: "13800138000",
        groupId: "builder",
        groupLocked: false,
        enabled: true
      },
      {
        name: "Bob Business",
        phone: "13900139000",
        groupId: "business",
        groupLocked: false,
        enabled: true
      },
      {
        name: "Carol Admin",
        phone: "13700137000",
        groupId: "admin",
        groupLocked: true,
        enabled: true
      }
    ];
    const created = [];
    for (const input of inputs) {
      created.push(await repository.createUser(input, actor));
    }
    for (const user of created) {
      expect(user.accountId).toBe(`account-${user.personId}`);
    }
    store.mutate((state) => {
      state.chatIdentities?.push({
        id: "chat-alice",
        platform: "wechat",
        externalUserId: "wx-alice",
        displayName: "Alice",
        personId: created[0].personId,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-01T00:00:00.000Z"
      });
    });

    await expect(repository.getUser(created[0].accountId)).resolves.toMatchObject({
      personId: created[0].personId,
      permissions: ["ticket.claim", "ticket.process"],
      identities: {
        wechat: { externalUserId: "wx-alice" }
      }
    });
    await expect(repository.listUsers({
      search: "alice",
      groupId: "builder",
      enabled: true,
      admin: false,
      binding: "bound",
      page: 1,
      pageSize: 10
    })).resolves.toMatchObject({
      total: 1,
      users: [expect.objectContaining({ personId: created[0].personId })]
    });
    await expect(repository.listUsers({
      page: 2,
      pageSize: 2
    })).resolves.toMatchObject({
      total: 3,
      users: [expect.objectContaining({ name: "Carol Admin" })]
    });

    await repository.createAccountSession(
      created[0].accountId,
      "mobile",
      "name-session-hash",
      "2099-01-01T00:00:00.000Z"
    );
    const initialVersion = store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion ?? 0;
    await repository.updateUser(created[0].personId, {
      name: "Alice Renamed"
    }, actor);
    expect(store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion).toBe(initialVersion);
    await expect(
      repository.resolveAccountSession("name-session-hash", "mobile")
    ).resolves.toBeDefined();

    for (const mutation of [
      { phone: "13600136000" },
      { groupId: "business" },
      { enabled: false }
    ]) {
      const before = store.snapshot().accounts?.find(
        (item) => item.id === created[0].accountId
      )?.authVersion ?? 0;
      await repository.updateUser(created[0].personId, mutation, actor);
      expect(store.snapshot().accounts?.find(
        (item) => item.id === created[0].accountId
      )?.authVersion).toBe(before + 1);
    }

    await repository.setUserEnabled(created[0].personId, true, actor);
    const beforePassword = store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion ?? 0;
    await repository.setUserPassword(
      created[0].personId,
      "scrypt$private-password-hash",
      actor
    );
    expect(store.snapshot().accounts?.find(
      (item) => item.id === created[0].accountId
    )?.authVersion).toBe(beforePassword + 1);

    const auditText = JSON.stringify(store.snapshot().auditLogs);
    expect(auditText).toContain(actor.accountId);
    expect(auditText).toContain(created[0].personId);
    expect(auditText).not.toContain("scrypt$private-password-hash");
    expect(auditText).not.toContain("name-session-hash");
    expect(auditText).not.toContain("tokenHash");
    expect(auditText).not.toContain("passwordHash");

    await repository.deleteUser(created[1].personId, actor);
    await expect(
      repository.getUser(created[1].personId)
    ).resolves.toBeUndefined();
    expect(store.snapshot().accounts?.some(
      (item) => item.id === created[1].accountId
    )).toBe(false);
  });

  it("synchronizes exact roles and permissions while maintaining one role per account", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    store.mutate((state) => {
      state.accountRoles?.push({
        accountId: actor.accountId,
        roleId: "role-business",
        createdAt: "2026-01-01T00:00:00.000Z"
      });
      state.rolePermissions?.push({
        roleId: "role-builder",
        permissionCode: "admin.access",
        createdAt: "2026-01-01T00:00:00.000Z"
      });
    });

    const nextGroups = groups.map((group) => (
      group.id === "builder"
        ? {
            ...group,
            canClaim: false,
            canProcess: true,
            canAdmin: false
          }
        : group
    ));
    await repository.syncAccessRoles(nextGroups, adminActor());

    const snapshot = store.snapshot();
    expect(snapshot.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "role-builder",
        sourceGroupId: "builder"
      })
    ]));
    expect(snapshot.rolePermissions?.filter(
      (item) => item.roleId === "role-builder"
    )).toEqual([
      expect.objectContaining({ permissionCode: "ticket.process" })
    ]);
    expect(snapshot.accountRoles?.filter(
      (item) => item.accountId === actor.accountId
    )).toEqual([
      expect.objectContaining({ roleId: "role-builder" })
    ]);
  });

  it("invalidates authorization when saveConfig changes access groups", async () => {
    const store = memoryStore();
    const repository = createFileAppRepository(store);
    const { actor } = await createMobile(repository);
    await repository.createAccountSession(
      actor.accountId,
      "mobile",
      "config-session-hash",
      "2099-01-01T00:00:00.000Z"
    );
    const before = store.snapshot().accounts?.[0]?.authVersion ?? 0;

    await repository.saveConfig({
      ...store.snapshot().config,
      userGroups: groups.map((group) => (
        group.id === "builder"
          ? { ...group, enabled: false }
          : group
      ))
    });

    expect(store.snapshot().accounts?.[0]?.authVersion).toBe(before + 1);
    await expect(
      repository.resolveAccountSession("config-session-hash", "mobile")
    ).resolves.toBeUndefined();
  });

  it("serializes fallback mutations across repository instances", async () => {
    const store = memoryStore(accessState(), false);
    const firstRepository = createFileAppRepository(store);
    const secondRepository = createFileAppRepository(store);
    const { actor } = await createMobile(firstRepository);
    await firstRepository.setUserPassword(
      actor.personId,
      "scrypt$stored-hash",
      actor
    );

    await Promise.all([
      firstRepository.recordAdminLoginFailure(actor.accountId),
      secondRepository.recordAdminLoginFailure(actor.accountId)
    ]);

    expect(store.snapshot().accountCredentials?.find(
      (item) => item.accountId === actor.accountId
    )?.failedAttempts).toBe(2);
  });

  it("rejects empty or invalid normalized phones deterministically", async () => {
    const repository = createFileAppRepository(memoryStore());

    await expect(repository.upsertMobileAccount({
      name: "Empty",
      phone: " -- ",
      groupId: "builder"
    })).rejects.toThrow(/phone|mobile/i);
    await expect(repository.upsertMobileAccount({
      name: "Invalid",
      phone: "12345",
      groupId: "builder"
    })).rejects.toThrow(/phone|mobile/i);
  });
});
