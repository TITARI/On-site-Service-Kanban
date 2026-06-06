import { afterEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import { defaultConfig } from "@/lib/seed";

type RecordedCall = [sql: string, params?: unknown[]];
const stateLockSql = "SELECT name FROM wxauto_integration_locks WHERE name = 'state-write' FOR UPDATE";

function recordingConnection(options: {
  reservationAffectedRows?: number;
  receiptRows?: unknown[];
  configRows?: unknown[];
  lockRows?: unknown[];
} = {}) {
  const calls: RecordedCall[] = [];
  const operations: string[] = [];
  const execute = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);
    operations.push(sql.replace(/\s+/g, " ").trim());

    if (sql.includes("FROM wxauto_integration_locks")) {
      return [options.lockRows ?? [{ name: "state-write" }]];
    }
    if (sql.includes("INSERT IGNORE INTO wxauto_event_receipts")) {
      return [{ affectedRows: options.reservationAffectedRows ?? 1 }];
    }
    if (sql.includes("FROM wxauto_event_receipts")) {
      return [options.receiptRows ?? []];
    }
    if (sql.includes("FROM app_config_versions")) {
      return [options.configRows ?? []];
    }
    if (/^\s*SELECT\b/i.test(sql)) {
      return [[]];
    }
    return [{ affectedRows: 1 }];
  });
  const beginTransaction = vi.fn(async () => {
    operations.push("beginTransaction");
  });
  const commit = vi.fn(async () => {
    operations.push("commit");
  });
  const rollback = vi.fn(async () => {
    operations.push("rollback");
  });

  return {
    connection: {
      execute,
      beginTransaction,
      commit,
      rollback
    } as unknown as PoolConnection,
    execute,
    beginTransaction,
    commit,
    rollback,
    calls,
    operations
  };
}

const eventInput = {
  deviceId: "device-a",
  events: [{
    messageId: "wx-1",
    sequence: 7,
    conversationId: "现场群",
    conversationType: "group" as const,
    senderId: "wxid-1",
    senderName: "张三",
    text: "大家好",
    imageUrls: ["https://example.com/photo.jpg"],
    receivedAt: "2026-06-05T08:00:00.000Z"
  }]
};

describe("wxauto agent store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("upserts agent health and returns registration settings from the latest config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T09:30:00.000Z"));
    const config = defaultConfig();
    config.messageIntegrations = config.messageIntegrations?.map((integration) => (
      integration.channel === "wechat" ? { ...integration, enabled: true } : integration
    ));
    const { connection, calls } = recordingConnection({
      configRows: [{ config_json: JSON.stringify(config) }]
    });

    const result = await new MariaDbStateStore().registerWxautoAgent({
      deviceId: "device-a",
      displayName: "Front Desk",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text", "image"]
    }, connection);

    expect(result).toEqual({
      deviceId: "device-a",
      serverTime: "2026-06-05T09:30:00.000Z",
      minimumAppVersion: "0.1.0",
      recommendedPollIntervalMs: 2000,
      integrationEnabled: true
    });
    const upsert = calls.find(([sql]) => sql.includes("INSERT INTO wxauto_agents"));
    expect(upsert?.[0]).toContain("ON DUPLICATE KEY UPDATE");
    expect(upsert?.[1]).toEqual([
      "device-a",
      "Front Desk",
      "0.1.0",
      "0.1.0",
      "Windows 11",
      "running",
      "logged_in",
      "strict",
      JSON.stringify(["text", "image"]),
      new Date("2026-06-05T09:30:00.000Z"),
      new Date("2026-06-05T09:30:00.000Z"),
      new Date("2026-06-05T09:30:00.000Z")
    ]);
  });

  it("returns the stored receipt without reading or rewriting business state when reservation loses", async () => {
    const storedReceipt = {
      messageId: "wx-1",
      action: "processed" as const,
      inboundMessageId: "message-1"
    };
    const { connection, calls, operations, beginTransaction, commit, rollback } = recordingConnection({
      reservationAffectedRows: 0,
      receiptRows: [{ result_json: JSON.stringify(storedReceipt) }]
    });

    const receipts = await new MariaDbStateStore().submitWxautoEvents(eventInput, connection);

    expect(receipts).toEqual([storedReceipt]);
    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(operations[0]).toBe("beginTransaction");
    expect(operations[1]).toBe(stateLockSql);
    expect(operations[2]).toContain("INSERT IGNORE INTO wxauto_event_receipts");
    expect(operations[3]).toContain("SELECT result_json FROM wxauto_event_receipts");
    expect(operations[4]).toBe("commit");
    expect(calls).toHaveLength(3);
    expect(calls.some(([sql]) => /\bDELETE FROM\b/i.test(sql))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("UPDATE wxauto_event_receipts"))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("FROM exhibition_booths"))).toBe(false);
  });

  it("processes the reservation winner and stores the final receipt in the same connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T09:30:00.000Z"));
    const { connection, calls, operations, beginTransaction, commit, rollback } = recordingConnection();
    const input = {
      ...eventInput,
      events: [{ ...eventInput.events[0], text: "" }]
    };

    const receipts = await new MariaDbStateStore().submitWxautoEvents(input, connection);

    expect(receipts).toEqual([{
      messageId: "wx-1",
      action: "ignored",
      inboundMessageId: expect.stringMatching(/^message-/)
    }]);

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(operations[0]).toBe("beginTransaction");
    expect(operations[1]).toBe(stateLockSql);
    expect(operations[2]).toContain("INSERT IGNORE INTO wxauto_event_receipts");
    expect(operations.at(-1)).toBe("commit");

    const inboundInsert = calls.find(([sql]) => sql.includes("INSERT INTO inbound_messages"));
    expect(inboundInsert?.[1]).toEqual([
      expect.stringMatching(/^message-/),
      "wechat",
      "wx-1",
      "wxid-1",
      "张三",
      null,
      "现场群",
      "",
      JSON.stringify(["https://example.com/photo.jpg"]),
      new Date("2026-06-05T08:00:00.000Z"),
      new Date("2026-06-05T09:30:00.000Z"),
      null,
      null,
      "现场群",
      JSON.stringify({ wxautoDeviceId: "device-a", sequence: 7 }),
      expect.any(String)
    ]);

    const receiptUpdate = calls.find(([sql]) => sql.includes("UPDATE wxauto_event_receipts"));
    expect(receiptUpdate?.[1]?.[1]).toBe("ignored");
    expect(JSON.parse(String(receiptUpdate?.[1]?.[2]))).toEqual(receipts[0]);
    expect(receiptUpdate?.[1]?.[3]).toMatch(/^wxauto-receipt-/);
    expect(calls.some(([sql]) => /\bDELETE FROM wxauto_event_receipts\b/i.test(sql))).toBe(false);
    expect(calls.some(([sql]) => /\bDELETE FROM wxauto_agents\b/i.test(sql))).toBe(false);
    expect(calls.some(([sql]) => /\bDELETE FROM wxauto_integration_locks\b/i.test(sql))).toBe(false);
  });

  it("rolls back when the state-write lock row is not initialized", async () => {
    const { connection, calls, beginTransaction, commit, rollback } = recordingConnection({
      lockRows: []
    });

    await expect(new MariaDbStateStore().submitWxautoEvents(eventInput, connection))
      .rejects.toThrow("wxauto state lock is not initialized");

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0][0].replace(/\s+/g, " ").trim()).toBe(stateLockSql);
  });

  it("rolls back and does not commit when batch work throws", async () => {
    const { connection, operations, beginTransaction, commit, rollback } = recordingConnection();
    const store = new MariaDbStateStore();
    vi.spyOn(store, "readState").mockRejectedValue(new Error("business failure"));

    await expect(store.submitWxautoEvents(eventInput, connection))
      .rejects.toThrow("business failure");

    expect(beginTransaction).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(operations[0]).toBe("beginTransaction");
    expect(operations[1]).toBe(stateLockSql);
    expect(operations[2]).toContain("INSERT IGNORE INTO wxauto_event_receipts");
    expect(operations.at(-1)).toBe("rollback");
  });
});
