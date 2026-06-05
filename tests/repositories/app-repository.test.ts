import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { createAppRepository, createMariaDbAppRepository } from "@/lib/repositories/app-repository";
import type { MariaDbStateStore } from "@/lib/db/mariadb-state-store";

describe("app repository", () => {
  it("creates a MariaDB repository when DATABASE_URL is configured", () => {
    const repository = createAppRepository({
      DATABASE_URL: "mysql://board:secret@127.0.0.1:3306/collaboration_board"
    } as unknown as NodeJS.ProcessEnv);

    expect(repository.kind).toBe("mariadb");
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
});
