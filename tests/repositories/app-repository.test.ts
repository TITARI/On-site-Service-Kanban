import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { createAppRepository, createFileAppRepository, createMariaDbAppRepository } from "@/lib/repositories/app-repository";
import type { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { AppState } from "@/lib/domain/app-state";

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

  it("exposes clear temporary MariaDB stubs for access methods", async () => {
    const repository = createMariaDbAppRepository({} as MariaDbStateStore);

    await expect(repository.bootstrapStatus()).rejects.toThrow(
      /MariaDB access repository is not implemented/i
    );
    await expect(repository.listUsers({
      page: 1,
      pageSize: 20
    })).rejects.toThrow(/MariaDB access repository is not implemented/i);
  });
});
