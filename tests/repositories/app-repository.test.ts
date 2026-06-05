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
    const registration = {
      deviceId: "device-a",
      serverTime: "2026-06-05T09:30:00.000Z",
      minimumAppVersion: "0.1.0",
      recommendedPollIntervalMs: 2000,
      integrationEnabled: true
    };
    const receipts = [{ messageId: "wx-1", action: "ignored" as const }];
    const store = {
      getConfig: vi.fn(async () => config),
      saveTicket: vi.fn(async (ticket) => ticket),
      listWechatOrderLogs: vi.fn(async () => []),
      registerWxautoAgent: vi.fn(async () => registration),
      submitWxautoEvents: vi.fn(async () => receipts)
    } as unknown as MariaDbStateStore;
    const repository = createMariaDbAppRepository(store);
    const registerInput = {
      deviceId: "device-a",
      displayName: "Front Desk",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11",
      wechatProcessState: "running" as const,
      wechatLoginState: "logged_in" as const,
      safetyMode: "strict" as const,
      capabilities: ["text" as const]
    };
    const submitInput = {
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "现场群",
        conversationType: "group" as const,
        senderName: "张三",
        text: "大家好",
        imageUrls: [],
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    };

    await expect(repository.getConfig()).resolves.toBe(config);
    await expect(repository.listWechatOrderLogs(20)).resolves.toEqual([]);
    await expect(repository.registerWxautoAgent(registerInput)).resolves.toBe(registration);
    await expect(repository.submitWxautoEvents(submitInput)).resolves.toBe(receipts);

    expect(store.getConfig).toHaveBeenCalledOnce();
    expect(store.listWechatOrderLogs).toHaveBeenCalledWith(20);
    expect(store.registerWxautoAgent).toHaveBeenCalledWith(registerInput);
    expect(store.submitWxautoEvents).toHaveBeenCalledWith(submitInput);
  });
});
