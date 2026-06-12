import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { createAppRepository, createFileAppRepository, createMariaDbAppRepository } from "@/lib/repositories/app-repository";
import type { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { AppState } from "@/lib/domain/app-state";
import { verifyPassword } from "@/lib/services/password-service";

function state(): AppState {
  return {
    booths: [{ boothNumber: "A01", companyName: "Test Company", companyShortName: "Test", salesOwner: "Owner", builder: "Builder" }],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig()
  };
}

describe("app repository", () => {
  it("creates a MariaDB repository when DATABASE_URL is configured", () => {
    const repository = createAppRepository({
      DATABASE_URL: "mysql://board:secret@127.0.0.1:3306/collaboration_board"
    } as unknown as NodeJS.ProcessEnv);

    expect(repository.kind).toBe("mariadb");
  });

  it("uses the JSON file repository in development when DATABASE_URL is missing", () => {
    const repository = createAppRepository({
      NODE_ENV: "development"
    } as unknown as NodeJS.ProcessEnv);

    expect(repository.kind).toBe("file");
  });

  it("bootstraps admin data from the JSON file repository", async () => {
    const appState = state();
    const repository = createFileAppRepository({
      readState: vi.fn(async () => appState),
      writeState: vi.fn(async () => undefined)
    });

    await expect(repository.adminBootstrap()).resolves.toEqual({
      tickets: [],
      booths: appState.booths,
      messageRecords: [],
      people: [],
      chatIdentities: [],
      conversations: [],
      pendingWorkOrderSessions: [],
      outboundMessages: [],
      config: appState.config
    });
  });

  it("delegates repository methods to the MariaDB state store", async () => {
    const config = defaultConfig();
    const actor = {
      accountId: "account-1",
      personId: "person-1",
      name: "Alice",
      phone: "13800138000",
      groupId: "ops",
      groupName: "Operations",
      permissions: [],
      sessionType: "mobile" as const
    };
    const store = {
      getConfig: vi.fn(async () => config),
      saveTicket: vi.fn(async (ticket) => ticket),
      listWechatOrderLogs: vi.fn(async () => []),
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdmin: vi.fn(async () => ({ ...actor, sessionType: "admin" as const })),
      upsertMobileAccount: vi.fn(async () => ({ actor }))
    } as unknown as MariaDbStateStore;
    const repository = createMariaDbAppRepository(
      store as Parameters<typeof createMariaDbAppRepository>[0]
    );

    await expect(repository.getConfig()).resolves.toBe(config);
    await expect(repository.listWechatOrderLogs(20)).resolves.toEqual([]);
    await expect(repository.bootstrapStatus()).resolves.toEqual({ required: true });
    await repository.upsertMobileAccount({ name: "Alice", phone: "13800138000", groupId: "ops" });
    await repository.bootstrapAdmin({
      legacyPassword: "legacy-secret",
      name: "Root",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    });

    expect(store.getConfig).toHaveBeenCalledOnce();
    expect(store.listWechatOrderLogs).toHaveBeenCalledWith(20);
    expect(store.bootstrapStatus).toHaveBeenCalledOnce();
    expect(store.upsertMobileAccount).toHaveBeenCalledWith({
      name: "Alice",
      phone: "13800138000",
      groupId: "ops"
    });
    expect(store.bootstrapAdmin).toHaveBeenCalledWith({
      name: "Root",
      phone: "13700137000",
      group: { mode: "existing", groupId: "admin" },
      passwordHash: expect.any(String)
    });
    const persistedInput = store.bootstrapAdmin.mock.calls[0][0] as { passwordHash: string };
    await expect(verifyPassword("StrongPass123!", persistedInput.passwordHash)).resolves.toBe(true);
  });

  it("forwards every access repository method and its parameters to MariaDB", async () => {
    const actor = {
      accountId: "account-1",
      personId: "person-1",
      name: "Admin",
      phone: "13700137000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access" as const],
      sessionType: "admin" as const
    };
    const userInput = {
      name: "Alice",
      phone: "13800138000",
      groupId: "ops",
      groupLocked: false,
      enabled: true
    };
    const query = {
      search: "Alice",
      groupId: "ops",
      enabled: true,
      admin: false,
      binding: "bound" as const,
      page: 2,
      pageSize: 20
    };
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const lockedUntil = new Date(Date.now() + 120_000).toISOString();
    const accessStore = {
      upsertMobileAccount: vi.fn(async () => ({ actor: { ...actor, sessionType: "mobile" as const } })),
      createAccountSession: vi.fn(async () => undefined),
      resolveAccountSession: vi.fn(async () => undefined),
      revokeAccountSession: vi.fn(async () => undefined),
      revokeAccountSessions: vi.fn(async () => undefined),
      adminLoginRecord: vi.fn(async () => undefined),
      recordAdminLoginFailure: vi.fn(async () => undefined),
      recordAdminLoginSuccess: vi.fn(async () => undefined),
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdmin: vi.fn(async () => actor),
      listUsers: vi.fn(async () => ({ users: [], total: 0 })),
      getUser: vi.fn(async () => undefined),
      createUser: vi.fn(async () => undefined),
      updateUser: vi.fn(async () => undefined),
      setUserEnabled: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
      setUserPassword: vi.fn(async () => undefined),
      syncAccessRoles: vi.fn(async () => undefined)
    };
    const repository = createMariaDbAppRepository(
      accessStore as unknown as Parameters<typeof createMariaDbAppRepository>[0]
    );

    await repository.upsertMobileAccount({ name: "Alice", phone: "13800138000", groupId: "ops" });
    await repository.createAccountSession("account-1", "mobile", "session-hash", expiresAt);
    await repository.resolveAccountSession("session-hash", "mobile");
    await repository.revokeAccountSession("session-hash");
    await repository.revokeAccountSessions("account-1");
    await repository.adminLoginRecord("13700137000");
    await repository.recordAdminLoginFailure("account-1", lockedUntil);
    await repository.recordAdminLoginSuccess("account-1");
    await repository.bootstrapStatus();
    const bootstrapSession = {
      sessionType: "admin" as const,
      tokenHash: "bootstrap-session-hash",
      expiresAt
    };
    await repository.bootstrapAdmin(
      {
        legacyPassword: "legacy-secret",
        name: "Admin",
        phone: "13700137000",
        password: "StrongPass123!",
        group: { mode: "existing", groupId: "admin" }
      },
      bootstrapSession
    );
    await repository.listUsers(query);
    await repository.getUser("person-1");
    await repository.createUser(userInput, actor);
    await repository.updateUser("person-1", { name: "Alice Updated" }, actor);
    await repository.setUserEnabled("person-1", false, actor);
    await repository.deleteUser("person-1", actor);
    await repository.setUserPassword("person-1", "scrypt$stored-hash", actor);
    await repository.syncAccessRoles(groupsForDelegation(), actor);

    const expectedCalls: Array<[keyof typeof accessStore, unknown[]]> = [
      ["upsertMobileAccount", [{ name: "Alice", phone: "13800138000", groupId: "ops" }]],
      ["createAccountSession", ["account-1", "mobile", "session-hash", expiresAt]],
      ["resolveAccountSession", ["session-hash", "mobile"]],
      ["revokeAccountSession", ["session-hash"]],
      ["revokeAccountSessions", ["account-1"]],
      ["adminLoginRecord", ["13700137000"]],
      ["recordAdminLoginFailure", ["account-1", lockedUntil]],
      ["recordAdminLoginSuccess", ["account-1"]],
      ["bootstrapStatus", []],
      ["listUsers", [query]],
      ["getUser", ["person-1"]],
      ["createUser", [userInput, actor]],
      ["updateUser", ["person-1", { name: "Alice Updated" }, actor]],
      ["setUserEnabled", ["person-1", false, actor]],
      ["deleteUser", ["person-1", actor]],
      ["setUserPassword", ["person-1", "scrypt$stored-hash", actor]],
      ["syncAccessRoles", [groupsForDelegation(), actor]]
    ];
    for (const [method, args] of expectedCalls) {
      expect(accessStore[method]).toHaveBeenCalledWith(...args);
    }

    expect(accessStore.bootstrapAdmin).toHaveBeenCalledWith({
      name: "Admin",
      phone: "13700137000",
      group: { mode: "existing", groupId: "admin" },
      passwordHash: expect.any(String)
    }, bootstrapSession);
    const bootstrapInput = accessStore.bootstrapAdmin.mock.calls[0][0] as { passwordHash: string };
    await expect(verifyPassword("StrongPass123!", bootstrapInput.passwordHash)).resolves.toBe(true);
  });
});

function groupsForDelegation() {
  return [{
    id: "ops",
    name: "Operations",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }];
}
