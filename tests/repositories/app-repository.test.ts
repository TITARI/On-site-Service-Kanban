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
});
