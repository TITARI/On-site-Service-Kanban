import { afterEach, describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";
import { defaultConfig } from "@/lib/seed";

type RecordedCall = [sql: string, params?: unknown[]];

function recordingConnection(options: {
  reservationAffectedRows?: number;
  receiptRows?: unknown[];
  configRows?: unknown[];
} = {}) {
  const calls: RecordedCall[] = [];
  const execute = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);

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

  return {
    connection: { execute } as unknown as DatabaseConnection,
    execute,
    calls
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
    const { connection, calls } = recordingConnection({
      reservationAffectedRows: 0,
      receiptRows: [{ result_json: JSON.stringify(storedReceipt) }]
    });

    const receipts = await new MariaDbStateStore().submitWxautoEvents(eventInput, connection);

    expect(receipts).toEqual([storedReceipt]);
    expect(calls.map(([sql]) => sql.trim())).toHaveLength(2);
    expect(calls[0][0]).toContain("INSERT IGNORE INTO wxauto_event_receipts");
    expect(calls[1][0]).toContain("SELECT result_json FROM wxauto_event_receipts");
    expect(calls.some(([sql]) => /\bDELETE FROM\b/i.test(sql))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("UPDATE wxauto_event_receipts"))).toBe(false);
    expect(calls.some(([sql]) => sql.includes("FROM exhibition_booths"))).toBe(false);
  });

  it("processes the reservation winner and stores the final receipt in the same connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T09:30:00.000Z"));
    const { connection, calls } = recordingConnection();
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
  });
});
