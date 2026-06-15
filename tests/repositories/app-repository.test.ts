import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { createAppRepository, createFileAppRepository, createMariaDbAppRepository } from "@/lib/repositories/app-repository";
import type { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { AppState } from "@/lib/domain/app-state";
import type {
  AuthenticatedActor,
  BootstrapAdminInput,
  UserMutation,
  UserQuery
} from "@/lib/domain/access-control";

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
      updateState: vi.fn(async <T>(
        operation: (state: AppState) => Promise<T> | T
      ) => operation(appState))
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

  it("rejects custom file stores without an atomic updateState", () => {
    expect(() => createFileAppRepository({
      readState: vi.fn(async () => state()),
      writeState: vi.fn(async () => undefined)
    } as unknown as Parameters<typeof createFileAppRepository>[0])).toThrow(
      /updateState.*required/i
    );
  });

  it("delegates repository methods to the MariaDB state store", async () => {
    const config = defaultConfig();
    const store = {
      getConfig: vi.fn(async () => config),
      saveTicket: vi.fn(async (ticket) => ticket),
      listWechatOrderLogs: vi.fn(async () => [])
    } as unknown as MariaDbStateStore;
    const repository = createMariaDbAppRepository(store);

    await expect(repository.getConfig()).resolves.toBe(config);
    await expect(repository.listWechatOrderLogs(20)).resolves.toEqual([]);

    expect(store.getConfig).toHaveBeenCalledOnce();
    expect(store.listWechatOrderLogs).toHaveBeenCalledWith(20);
  });

  it("delegates every access method to the MariaDB state store", async () => {
    const actor = {
      accountId: "account-admin",
      personId: "person-admin",
      name: "Root Admin",
      phone: "13700137000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access"],
      sessionType: "admin"
    } satisfies AuthenticatedActor;
    const userInput = {
      name: "Alice",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: false,
      enabled: true
    } satisfies UserMutation;
    const userQuery = {
      page: 1,
      pageSize: 20
    } satisfies UserQuery;
    const bootstrapInput = {
      legacyPassword: "legacy",
      name: "Root Admin",
      phone: "13700137000",
      password: "StrongPass123!",
      group: { mode: "existing", groupId: "admin" }
    } satisfies BootstrapAdminInput;
    const groups = defaultConfig().userGroups ?? [];
    const store = {
      upsertMobileAccount: vi.fn(async () => ({ actor })),
      createAccountSession: vi.fn(async () => ({ id: "session-1" })),
      resolveAccountSession: vi.fn(async () => undefined),
      revokeAccountSession: vi.fn(async () => undefined),
      revokeAccountSessions: vi.fn(async () => undefined),
      adminLoginRecord: vi.fn(async () => undefined),
      recordAdminLoginFailure: vi.fn(async () => undefined),
      recordAdminLoginSuccess: vi.fn(async () => undefined),
      bootstrapStatus: vi.fn(async () => ({ required: true })),
      bootstrapAdmin: vi.fn(async () => actor),
      bootstrapAdminWithSession: vi.fn(async () => ({ actor, session: { id: "session-admin" } })),
      listUsers: vi.fn(async () => ({ users: [], total: 0 })),
      getUser: vi.fn(async () => undefined),
      createUser: vi.fn(async () => undefined),
      updateUser: vi.fn(async () => undefined),
      setUserEnabled: vi.fn(async () => undefined),
      deleteUser: vi.fn(async () => undefined),
      setUserPassword: vi.fn(async () => undefined),
      syncAccessRoles: vi.fn(async () => undefined)
    } as unknown as MariaDbStateStore;
    const repository = createMariaDbAppRepository(store);

    await repository.upsertMobileAccount(userInput);
    await repository.createAccountSession("account-admin", "admin", "a".repeat(64), "2099-01-01T00:00:00.000Z");
    await repository.resolveAccountSession("a".repeat(64), "admin");
    await repository.revokeAccountSession("a".repeat(64));
    await repository.revokeAccountSessions("account-admin");
    await repository.adminLoginRecord("13700137000");
    await repository.recordAdminLoginFailure("account-admin", "2099-01-01T00:00:00.000Z");
    await repository.recordAdminLoginSuccess("account-admin");
    await repository.bootstrapStatus();
    await repository.bootstrapAdmin(bootstrapInput);
    await repository.bootstrapAdminWithSession(
      bootstrapInput,
      "b".repeat(64),
      "2099-01-01T00:00:00.000Z"
    );
    await repository.listUsers(userQuery);
    await repository.getUser("person-admin");
    await repository.createUser(userInput, actor);
    await repository.updateUser("person-admin", { name: "Admin" }, actor);
    await repository.setUserEnabled("person-admin", false, actor);
    await repository.deleteUser("person-admin", actor);
    await repository.setUserPassword("person-admin", "scrypt$hash", actor);
    await repository.syncAccessRoles(groups, actor);

    expect(store.upsertMobileAccount).toHaveBeenCalledWith(userInput);
    expect(store.createAccountSession).toHaveBeenCalledWith(
      "account-admin",
      "admin",
      "a".repeat(64),
      "2099-01-01T00:00:00.000Z"
    );
    expect(store.resolveAccountSession).toHaveBeenCalledWith("a".repeat(64), "admin");
    expect(store.revokeAccountSession).toHaveBeenCalledWith("a".repeat(64));
    expect(store.revokeAccountSessions).toHaveBeenCalledWith("account-admin");
    expect(store.adminLoginRecord).toHaveBeenCalledWith("13700137000");
    expect(store.recordAdminLoginFailure).toHaveBeenCalledWith(
      "account-admin",
      "2099-01-01T00:00:00.000Z"
    );
    expect(store.recordAdminLoginSuccess).toHaveBeenCalledWith("account-admin");
    expect(store.bootstrapStatus).toHaveBeenCalledOnce();
    expect(store.bootstrapAdmin).toHaveBeenCalledWith(bootstrapInput);
    expect(store.bootstrapAdminWithSession).toHaveBeenCalledWith(
      bootstrapInput,
      "b".repeat(64),
      "2099-01-01T00:00:00.000Z"
    );
    expect(store.listUsers).toHaveBeenCalledWith(userQuery);
    expect(store.getUser).toHaveBeenCalledWith("person-admin");
    expect(store.createUser).toHaveBeenCalledWith(userInput, actor);
    expect(store.updateUser).toHaveBeenCalledWith(
      "person-admin",
      { name: "Admin" },
      actor
    );
    expect(store.setUserEnabled).toHaveBeenCalledWith("person-admin", false, actor);
    expect(store.deleteUser).toHaveBeenCalledWith("person-admin", actor);
    expect(store.setUserPassword).toHaveBeenCalledWith(
      "person-admin",
      "scrypt$hash",
      actor
    );
    expect(store.syncAccessRoles).toHaveBeenCalledWith(groups, actor);
  });
});
