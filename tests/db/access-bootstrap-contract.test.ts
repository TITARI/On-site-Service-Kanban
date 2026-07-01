import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { AppState } from "@/lib/domain/app-state";
import type { AuthenticatedActor, BootstrapAdminInput } from "@/lib/domain/access-control";
import { defaultConfig } from "@/lib/seed";

const databaseMocks = vi.hoisted(() => {
  let connection: DatabaseConnection;
  return {
    getDatabasePool: vi.fn(() => connection),
    setConnection: (next: DatabaseConnection) => {
      connection = next;
    },
    withDatabaseTransaction: vi.fn(async <T>(
      operation: (connection: DatabaseConnection) => Promise<T>
    ) => operation(connection))
  };
});

const accessServiceMocks = vi.hoisted(() => ({
  bootstrapAdminInState: vi.fn(),
  createAccountSessionInState: vi.fn()
}));

const accessStoreMocks = vi.hoisted(() => ({
  legacyBootstrapAdmin: vi.fn(),
  loadBootstrapAccessState: vi.fn(),
  saveBootstrapAccessState: vi.fn(),
  readAccessGroups: vi.fn(),
  syncAccessRoles: vi.fn()
}));

vi.mock("@/lib/db/connection", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/connection")>(
    "@/lib/db/connection"
  );
  return {
    ...actual,
    getDatabasePool: databaseMocks.getDatabasePool,
    withDatabaseTransaction: databaseMocks.withDatabaseTransaction
  };
});

vi.mock("@/lib/services/password-service", () => ({
  hashPassword: vi.fn(async () => "scrypt$test-password-hash")
}));

vi.mock("@/lib/services/access-state-service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/services/access-state-service")>(
    "@/lib/services/access-state-service"
  );
  accessServiceMocks.bootstrapAdminInState.mockImplementation(actual.bootstrapAdminInState);
  accessServiceMocks.createAccountSessionInState.mockImplementation(actual.createAccountSessionInState);
  return {
    ...actual,
    bootstrapAdminInState: accessServiceMocks.bootstrapAdminInState,
    createAccountSessionInState: accessServiceMocks.createAccountSessionInState
  };
});

vi.mock("@/lib/db/mariadb-access-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/mariadb-access-store")>(
    "@/lib/db/mariadb-access-store"
  );
  return {
    ...actual,
    bootstrapAdmin: accessStoreMocks.legacyBootstrapAdmin,
    loadBootstrapAccessState: accessStoreMocks.loadBootstrapAccessState,
    saveBootstrapAccessState: accessStoreMocks.saveBootstrapAccessState,
    readAccessGroups: accessStoreMocks.readAccessGroups,
    syncAccessRoles: accessStoreMocks.syncAccessRoles
  };
});

const { MariaDbStateStore } = await import("@/lib/db/mariadb-state-store");
const { createFileAppRepository } = await import("@/lib/repositories/app-repository");

const input = {
  legacyPassword: "legacy-secret",
  name: "Root Admin",
  phone: "13700137000",
  password: "StrongPass123!",
  group: { mode: "existing", groupId: "admin" }
} satisfies BootstrapAdminInput;

function initialState(): AppState {
  const at = "2026-07-01T00:00:00.000Z";
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [{
      id: "person-admin",
      name: "Pending Admin",
      phone: "13700137000",
      role: "reporter",
      groupId: "admin",
      groupName: "Administrators",
      groupLocked: false,
      enabled: true,
      version: 0,
      createdAt: at,
      updatedAt: at
    }],
    chatIdentities: [],
    accounts: [{
      id: "account-person-admin",
      personId: "person-admin",
      loginName: "13700137000",
      enabled: true,
      authVersion: 1,
      version: 0,
      createdAt: at,
      updatedAt: at
    }],
    accountCredentials: [],
    roles: [],
    accountRoles: [],
    rolePermissions: [],
    accountSessions: [],
    auditLogs: [],
    authBootstrap: {},
    config: {
      ...defaultConfig(),
      userGroups: [{
        id: "admin",
        name: "Administrators",
        description: "",
        canClaim: false,
        canProcess: false,
        canAccept: false,
        canAdmin: false,
        enabled: false
      }]
    }
  };
}

function actor(): AuthenticatedActor {
  return {
    accountId: "account-person-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin"
  };
}

function connection(): DatabaseConnection {
  return {
    execute: vi.fn(async (sql: string) => (
      sql.trimStart().startsWith("SELECT")
        ? [[]]
        : [{ affectedRows: 1 }]
    ))
  } as unknown as DatabaseConnection;
}

function accessProjection(state: AppState) {
  return {
    groups: state.config.userGroups?.map(({ id, canAdmin, enabled }) => ({ id, canAdmin, enabled })),
    people: state.people?.map(({ id, name, phone, role, groupId, groupLocked, enabled }) => ({
      id,
      name,
      phone,
      role,
      groupId,
      groupLocked,
      enabled
    })),
    accounts: state.accounts?.map(({ id, personId, loginName, enabled, authVersion }) => ({
      id,
      personId,
      loginName,
      enabled,
      authVersion
    })),
    roles: state.roles?.map(({ id, sourceGroupId, enabled }) => ({ id, sourceGroupId, enabled })),
    accountRoles: state.accountRoles?.map(({ accountId, roleId }) => ({ accountId, roleId })),
    rolePermissions: state.rolePermissions?.map(({ roleId, permissionCode }) => ({ roleId, permissionCode })),
    bootstrapAccountId: state.authBootstrap?.completedByAccountId,
    auditActions: state.auditLogs?.map((entry) => entry.action)
  };
}

beforeEach(() => {
  const state = initialState();
  databaseMocks.setConnection(connection());
  databaseMocks.withDatabaseTransaction.mockClear();
  accessServiceMocks.bootstrapAdminInState.mockClear();
  accessServiceMocks.createAccountSessionInState.mockClear();
  accessStoreMocks.legacyBootstrapAdmin.mockReset();
  accessStoreMocks.loadBootstrapAccessState.mockReset();
  accessStoreMocks.saveBootstrapAccessState.mockReset();
  accessStoreMocks.readAccessGroups.mockReset();
  accessStoreMocks.syncAccessRoles.mockReset();
  accessStoreMocks.legacyBootstrapAdmin.mockResolvedValue(actor());
  accessStoreMocks.loadBootstrapAccessState.mockResolvedValue(structuredClone(state));
  accessStoreMocks.saveBootstrapAccessState.mockResolvedValue(undefined);
  accessStoreMocks.readAccessGroups.mockResolvedValue(state.config.userGroups);
  accessStoreMocks.syncAccessRoles.mockResolvedValue(undefined);
});

describe("access bootstrap storage contract", () => {
  it("runs MariaDB bootstrap through the shared state command", async () => {
    const result = await new MariaDbStateStore().bootstrapAdmin(input);

    expect(result).toEqual(actor());
    expect(accessServiceMocks.bootstrapAdminInState).toHaveBeenCalledOnce();
    expect(accessStoreMocks.saveBootstrapAccessState).toHaveBeenCalledOnce();
    const [, , savedAfter] = accessStoreMocks.saveBootstrapAccessState.mock.calls[0] as [
      DatabaseConnection,
      AppState,
      AppState
    ];
    expect(savedAfter).toMatchObject({
      authBootstrap: { completedByAccountId: "account-person-admin" },
      people: [expect.objectContaining({
        id: "person-admin",
        role: "admin",
        groupLocked: true
      })],
      accounts: [expect.objectContaining({
        id: "account-person-admin",
        authVersion: 3
      })]
    });
    expect(savedAfter.config.userGroups).toContainEqual(
      expect.objectContaining({ id: "admin", canAdmin: true, enabled: true })
    );
    expect(savedAfter.auditLogs).toContainEqual(
      expect.objectContaining({ action: "admin.bootstrap" })
    );
  });

  it("produces the same access semantics for file and MariaDB storage", async () => {
    let fileState = initialState();
    const fileRepository = createFileAppRepository({
      readState: async () => structuredClone(fileState),
      updateState: async <T>(operation: (state: AppState) => T | Promise<T>) => {
        const draft = structuredClone(fileState);
        const result = await operation(draft);
        fileState = draft;
        return result;
      }
    });

    const mariaActor = await new MariaDbStateStore().bootstrapAdmin(input);
    const fileActor = await fileRepository.bootstrapAdmin(input);
    const [, , mariaState] = accessStoreMocks.saveBootstrapAccessState.mock.calls[0] as [
      DatabaseConnection,
      AppState,
      AppState
    ];

    expect(mariaActor).toEqual(fileActor);
    expect(accessProjection(mariaState)).toEqual(accessProjection(fileState));
  });

  it("creates the first admin session through the shared state command in the same save", async () => {
    const tokenHash = "b".repeat(64);

    const result = await new MariaDbStateStore().bootstrapAdminWithSession(
      input,
      tokenHash,
      "2099-01-01T00:00:00.000Z"
    );

    expect(accessServiceMocks.bootstrapAdminInState).toHaveBeenCalledOnce();
    expect(accessServiceMocks.createAccountSessionInState).toHaveBeenCalledOnce();
    expect(accessStoreMocks.saveBootstrapAccessState).toHaveBeenCalledOnce();
    const [, , savedAfter] = accessStoreMocks.saveBootstrapAccessState.mock.calls[0] as [
      DatabaseConnection,
      AppState,
      AppState
    ];
    const account = savedAfter.accounts?.find((item) => item.id === result.actor.accountId);
    expect(savedAfter.accountSessions).toEqual([
      expect.objectContaining({
        id: result.session.id,
        accountId: result.actor.accountId,
        sessionType: "admin",
        tokenHash,
        authVersion: account?.authVersion
      })
    ]);
  });

  it("rejects an already completed bootstrap before issuing storage writes", async () => {
    const state = initialState();
    state.authBootstrap = {
      completedAt: "2026-07-01T00:00:00.000Z",
      completedByAccountId: "account-person-admin"
    };
    accessStoreMocks.loadBootstrapAccessState.mockResolvedValueOnce(state);

    await expect(new MariaDbStateStore().bootstrapAdmin(input))
      .rejects.toThrow(/bootstrap.*completed/i);

    expect(accessStoreMocks.saveBootstrapAccessState).not.toHaveBeenCalled();
  });

  it("propagates delta persistence failures without returning an actor", async () => {
    const failure = new Error("bootstrap delta write failed");
    accessStoreMocks.saveBootstrapAccessState.mockRejectedValueOnce(failure);

    await expect(new MariaDbStateStore().bootstrapAdmin(input)).rejects.toBe(failure);
    expect(databaseMocks.withDatabaseTransaction).toHaveBeenCalledOnce();
  });

  it("revokes existing sessions when bootstrapping an existing account", async () => {
    const state = initialState();
    state.accountSessions = [{
      id: "session-existing",
      accountId: "account-person-admin",
      sessionType: "admin",
      tokenHash: "c".repeat(64),
      authVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastSeenAt: "2026-07-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z"
    }];
    accessStoreMocks.loadBootstrapAccessState.mockResolvedValueOnce(state);

    await new MariaDbStateStore().bootstrapAdmin(input);

    const [, , savedAfter] = accessStoreMocks.saveBootstrapAccessState.mock.calls[0] as [
      DatabaseConnection,
      AppState,
      AppState
    ];
    expect(savedAfter.accounts?.[0].authVersion).toBeGreaterThan(1);
    expect(savedAfter.accountSessions?.[0]).toEqual(expect.objectContaining({
      id: "session-existing",
      revokedAt: expect.any(String)
    }));
  });
});
