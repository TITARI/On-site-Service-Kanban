import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AppState } from "@/lib/domain/app-state";
import type { OutboundMessage } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";

const database = vi.hoisted(() => ({
  connection: undefined as PoolConnection | undefined
}));

vi.mock("@/lib/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/connection")>();
  const connection = () => {
    if (!database.connection) throw new Error("test database connection is not configured");
    return database.connection;
  };
  return {
    ...actual,
    getDatabasePool: connection,
    withDatabaseConnection: async <T>(work: (connection: PoolConnection) => Promise<T>) => work(connection()),
    withDatabaseTransaction: async <T>(work: (connection: PoolConnection) => Promise<T>) => {
      const target = connection();
      await target.beginTransaction();
      try {
        const result = await work(target);
        await target.commit();
        return result;
      } catch (error) {
        await target.rollback();
        throw error;
      }
    }
  };
});

import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";

type RecordedCall = [sql: string, params?: unknown[]];
type ExecuteHandler = (sql: string, params?: unknown[]) => unknown[] | { affectedRows: number };

const stateLockSql = "SELECT name FROM wxauto_integration_locks WHERE name = 'state-write' FOR UPDATE";
const now = new Date("2026-06-06T08:00:00.000Z");
const leaseExpiry = new Date("2026-06-06T08:02:00.000Z");

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function outboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbound-1",
    channel: "wechat",
    target_conversation_id: "conversation-1",
    target_chat_identity_id: "identity-1",
    target_name: "现场群",
    text: "工单已创建",
    related_ticket_id: "ticket-1",
    related_session_id: null,
    status: "sending",
    retry_count: 0,
    last_error: null,
    claimed_at: now,
    claimed_by_agent_id: "device-a",
    lease_id: "lease-1",
    lease_expires_at: leaseExpiry,
    safety_rule: null,
    sent_at: null,
    created_at: new Date("2026-06-06T07:00:00.000Z"),
    updated_at: now,
    ...overrides
  };
}

function recordingConnection(handler: ExecuteHandler = () => []) {
  const calls: RecordedCall[] = [];
  const operations: string[] = [];
  const execute = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push([sql, params]);
    operations.push(normalizeSql(sql));
    if (sql.includes("FROM wxauto_integration_locks")) {
      return [[{ name: "state-write" }]];
    }
    const result = handler(sql, params);
    return [result];
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
    calls,
    operations,
    beginTransaction,
    commit,
    rollback
  };
}

function emptyState(outboundMessages: OutboundMessage[] = []): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages,
    config: defaultConfig()
  };
}

function stateConnection(row: Record<string, unknown>) {
  return recordingConnection((sql) => {
    if (sql.includes("FROM outbound_messages")) return [row];
    if (/^\s*SELECT\b/i.test(sql)) return [];
    return { affectedRows: 1 };
  });
}

beforeEach(() => {
  database.connection = undefined;
  vi.useFakeTimers();
  vi.setSystemTime(now);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("wxauto outbound claims", () => {
  it("claims eligible rows with distinct agent-owned 120 second leases and a stable response shape", async () => {
    const candidates = [
      outboundRow({ id: "pending-1", status: "pending", claimed_at: null, lease_id: null }),
      outboundRow({
        id: "expired-1",
        status: "sending",
        claimed_at: new Date("2026-06-06T07:55:00.000Z"),
        lease_id: "expired-lease",
        lease_expires_at: new Date("2026-06-06T07:59:59.000Z")
      })
    ];
    const recorded = recordingConnection((sql) => (
      sql.includes("SELECT * FROM outbound_messages") ? candidates : { affectedRows: 1 }
    ));

    const leases = await new MariaDbStateStore().claimWxautoOutbound({
      deviceId: "device-a",
      limit: 2,
      supportedMessageTypes: ["text"]
    }, recorded.connection);

    expect(recorded.operations[0]).toBe("beginTransaction");
    expect(recorded.operations[1]).toBe(stateLockSql);
    expect(recorded.operations.at(-1)).toBe("commit");
    expect(recorded.beginTransaction).toHaveBeenCalledOnce();
    expect(recorded.commit).toHaveBeenCalledOnce();
    expect(recorded.rollback).not.toHaveBeenCalled();

    const select = recorded.calls.find(([sql]) => sql.includes("SELECT * FROM outbound_messages"));
    expect(normalizeSql(select?.[0] ?? "")).toMatch(
      /WHERE status = 'pending' OR \(status = 'failed' AND retry_count < 3\) OR \(status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= \?\) ORDER BY created_at LIMIT \? FOR UPDATE SKIP LOCKED/
    );
    expect(select?.[1]).toEqual([now, 2]);

    expect(leases).toEqual([
      {
        messageId: "pending-1",
        leaseId: expect.stringMatching(/^lease-/),
        leaseExpiresAt: leaseExpiry.toISOString(),
        targetName: "现场群",
        targetConversationId: "conversation-1",
        text: "工单已创建",
        createdAt: "2026-06-06T07:00:00.000Z"
      },
      {
        messageId: "expired-1",
        leaseId: expect.stringMatching(/^lease-/),
        leaseExpiresAt: leaseExpiry.toISOString(),
        targetName: "现场群",
        targetConversationId: "conversation-1",
        text: "工单已创建",
        createdAt: "2026-06-06T07:00:00.000Z"
      }
    ]);
    expect(leases[0].leaseId).not.toBe(leases[1].leaseId);

    const updates = recorded.calls.filter(([sql]) => sql.includes("UPDATE outbound_messages"));
    expect(updates).toHaveLength(2);
    expect(normalizeSql(updates[0][0])).toContain(
      "SET status = 'sending', claimed_at = ?, claimed_by_agent_id = ?, lease_id = ?, lease_expires_at = ?, updated_at = ?"
    );
    expect(updates[0][1]).toEqual([
      now,
      "device-a",
      leases[0].leaseId,
      leaseExpiry,
      now,
      "pending-1"
    ]);
  });

  it("rolls back a claim transaction when selecting candidates fails", async () => {
    const recorded = recordingConnection((sql) => {
      if (sql.includes("SELECT * FROM outbound_messages")) throw new Error("claim failed");
      return [];
    });

    await expect(new MariaDbStateStore().claimWxautoOutbound({
      deviceId: "device-a",
      limit: 10,
      supportedMessageTypes: ["text"]
    }, recorded.connection)).rejects.toThrow("claim failed");

    expect(recorded.operations).toEqual([
      "beginTransaction",
      stateLockSql,
      expect.stringContaining("SELECT * FROM outbound_messages"),
      "rollback"
    ]);
    expect(recorded.commit).not.toHaveBeenCalled();
    expect(recorded.rollback).toHaveBeenCalledOnce();
  });
});

describe("wxauto outbound completion", () => {
  const completion = {
    deviceId: "device-a",
    messageId: "outbound-1",
    leaseId: "lease-1",
    status: "sent" as const,
    attemptedAt: "2026-06-06T07:59:30.000Z"
  };

  it("accepts a repeated completion for the same message, lease, and agent without another attempt", async () => {
    const recorded = recordingConnection((sql) => {
      if (sql.includes("FROM outbound_message_attempts")) {
        return [{ message_id: "outbound-1", agent_id: "device-a", lease_id: "lease-1", status: "sent" }];
      }
      if (sql.includes("FROM outbound_messages")) {
        return [outboundRow({ status: "sent", sent_at: now })];
      }
      return { affectedRows: 1 };
    });

    const result = await new MariaDbStateStore().completeWxautoOutbound(completion, recorded.connection);

    expect(result).toEqual({
      accepted: true,
      message: expect.objectContaining({
        id: "outbound-1",
        status: "sent",
        claimedByAgentId: "device-a",
        leaseId: "lease-1",
        leaseExpiresAt: leaseExpiry.toISOString()
      })
    });
    expect(recorded.calls.filter(([sql]) => sql.includes("INSERT INTO outbound_message_attempts"))).toHaveLength(0);
    expect(recorded.calls.filter(([sql]) => sql.includes("UPDATE outbound_messages"))).toHaveLength(0);
    expect(recorded.operations.slice(0, 3)).toEqual([
      "beginTransaction",
      stateLockSql,
      expect.stringContaining("FROM outbound_message_attempts")
    ]);
    expect(recorded.operations.at(-1)).toBe("commit");
  });

  it.each([
    ["another message", { message_id: "outbound-2", agent_id: "device-a" }],
    ["another agent", { message_id: "outbound-1", agent_id: "device-b" }]
  ])("rejects a prior lease replayed by %s", async (_label, identity) => {
    const recorded = recordingConnection((sql) => {
      if (sql.includes("FROM outbound_message_attempts")) {
        return [{ ...identity, lease_id: "lease-1", status: "sent" }];
      }
      return [];
    });

    await expect(new MariaDbStateStore().completeWxautoOutbound(completion, recorded.connection))
      .resolves.toEqual({ accepted: false });

    expect(recorded.calls.some(([sql]) => sql.includes("FROM outbound_messages"))).toBe(false);
    expect(recorded.calls.some(([sql]) => sql.includes("INSERT INTO outbound_message_attempts"))).toBe(false);
    expect(recorded.operations.at(-1)).toBe("commit");
  });

  it.each([
    {
      completion: { status: "sent" as const },
      storedStatus: "sent",
      expectedSql: "SET status = 'sent', sent_at = ?, last_error = NULL, safety_rule = NULL, updated_at = ?",
      expectedParams: [now, now, "outbound-1"]
    },
    {
      completion: { status: "failed" as const, error: "窗口不存在" },
      storedStatus: "failed",
      expectedSql: "SET status = 'failed', retry_count = retry_count + 1, last_error = ?, updated_at = ?",
      expectedParams: ["窗口不存在", now, "outbound-1"]
    },
    {
      completion: {
        status: "blocked_by_safety_policy" as const,
        error: "联系人不在白名单",
        safetyRule: "recipient_allowlist"
      },
      storedStatus: "blocked",
      expectedSql: "SET status = 'blocked', last_error = ?, safety_rule = ?, updated_at = ?",
      expectedParams: ["联系人不在白名单", "recipient_allowlist", now, "outbound-1"]
    }
  ])("locks and records one fresh $storedStatus completion", async ({
    completion: outcome,
    storedStatus,
    expectedSql,
    expectedParams
  }) => {
    let messageReads = 0;
    const recorded = recordingConnection((sql) => {
      if (sql.includes("FROM outbound_message_attempts")) return [];
      if (sql.includes("FROM outbound_messages")) {
        messageReads += 1;
        return [outboundRow(messageReads === 1 ? {} : {
          status: storedStatus,
          last_error: outcome.status === "sent" ? null : outcome.error,
          safety_rule: outcome.status === "blocked_by_safety_policy" ? outcome.safetyRule : null,
          sent_at: outcome.status === "sent" ? now : null
        })];
      }
      return { affectedRows: 1 };
    });

    const result = await new MariaDbStateStore().completeWxautoOutbound({
      ...completion,
      ...outcome
    }, recorded.connection);

    expect(result).toEqual({
      accepted: true,
      message: expect.objectContaining({ id: "outbound-1", status: storedStatus })
    });
    const messageSelects = recorded.calls.filter(([sql]) => sql.includes("FROM outbound_messages"));
    expect(normalizeSql(messageSelects[0][0])).toMatch(/WHERE id = \? (?:LIMIT 1 )?FOR UPDATE$/);
    expect(messageSelects[0][1]).toEqual(["outbound-1"]);

    const attempts = recorded.calls.filter(([sql]) => sql.includes("INSERT INTO outbound_message_attempts"));
    expect(attempts).toHaveLength(1);
    expect(attempts[0][1]).toEqual([
      expect.stringMatching(/^attempt-/),
      "outbound-1",
      "device-a",
      "lease-1",
      outcome.status,
      "error" in outcome ? outcome.error : null,
      "safetyRule" in outcome ? outcome.safetyRule : null,
      new Date(completion.attemptedAt),
      now
    ]);

    const update = recorded.calls.find(([sql]) => sql.includes("UPDATE outbound_messages"));
    expect(normalizeSql(update?.[0] ?? "")).toContain(expectedSql);
    expect(update?.[1]).toEqual(expectedParams);
    expect(recorded.operations.at(-1)).toBe("commit");
  });

  it("returns false for an invalid fresh lease without inserting an attempt", async () => {
    const recorded = recordingConnection((sql) => {
      if (sql.includes("FROM outbound_message_attempts")) return [];
      if (sql.includes("FROM outbound_messages")) return [outboundRow({ lease_id: "lease-other" })];
      return { affectedRows: 1 };
    });

    await expect(new MariaDbStateStore().completeWxautoOutbound(completion, recorded.connection))
      .resolves.toEqual({ accepted: false });

    expect(recorded.calls.some(([sql]) => sql.includes("INSERT INTO outbound_message_attempts"))).toBe(false);
    expect(recorded.calls.some(([sql]) => sql.includes("UPDATE outbound_messages"))).toBe(false);
    expect(recorded.operations.at(-1)).toBe("commit");
  });
});

describe("outbound lease compatibility", () => {
  it("preserves lease and safety fields through a full-state read/write roundtrip", async () => {
    const recorded = stateConnection(outboundRow({ safety_rule: "recipient_allowlist" }));
    const store = new MariaDbStateStore();

    const state = await store.readState(recorded.connection);
    expect(state.outboundMessages).toEqual([
      expect.objectContaining({
        claimedByAgentId: "device-a",
        leaseId: "lease-1",
        leaseExpiresAt: leaseExpiry.toISOString(),
        safetyRule: "recipient_allowlist"
      })
    ]);

    await store.writeState(state, recorded.connection);

    const insert = recorded.calls.find(([sql]) => sql.includes("INSERT INTO outbound_messages"));
    expect(normalizeSql(insert?.[0] ?? "")).toContain(
      "claimed_at, claimed_by_agent_id, lease_id, lease_expires_at, safety_rule, sent_at"
    );
    expect(insert?.[1]).toEqual([
      "outbound-1",
      "wechat",
      "conversation-1",
      "identity-1",
      "现场群",
      "工单已创建",
      "ticket-1",
      null,
      "sending",
      0,
      null,
      now,
      "device-a",
      "lease-1",
      leaseExpiry,
      "recipient_allowlist",
      null,
      new Date("2026-06-06T07:00:00.000Z"),
      now
    ]);
  });

  it("keeps an existing lease when processWechatMessage performs its full-state transaction", async () => {
    const recorded = stateConnection(outboundRow());
    const store = new MariaDbStateStore();

    const result = await store.processWechatMessage({
      channel: "wechat",
      externalMessageId: "legacy-inbound-1",
      senderId: "sender-1",
      senderName: "Legacy Sender",
      sourceConversationId: "conversation-1",
      text: ""
    }, recorded.connection);

    expect(result.action).toBe("ignored");
    expect(recorded.operations[0]).toBe("beginTransaction");
    expect(recorded.operations[1]).toBe(stateLockSql);
    const insert = recorded.calls.find(([sql]) => sql.includes("INSERT INTO outbound_messages"));
    expect(insert?.[1]).toEqual(expect.arrayContaining([
      "device-a",
      "lease-1",
      leaseExpiry
    ]));
    expect(recorded.operations.at(-1)).toBe("commit");
  });

  it("serializes the legacy claim bridge with the shared state lock", async () => {
    const recorded = recordingConnection((sql) => (
      sql.includes("SELECT * FROM outbound_messages") ? [] : { affectedRows: 1 }
    ));
    database.connection = recorded.connection;

    await expect(new MariaDbStateStore().claimOutboundMessages(5)).resolves.toEqual([]);

    expect(recorded.operations[0]).toBe("beginTransaction");
    expect(recorded.operations[1]).toBe(stateLockSql);
    expect(recorded.operations[2]).toContain("SELECT * FROM outbound_messages");
    expect(recorded.operations[2]).toMatch(/LIMIT \? FOR UPDATE$/);
    expect(recorded.operations.at(-1)).toBe("commit");
  });

  it("serializes legacy completion and locks the message row before updating", async () => {
    let reads = 0;
    const recorded = recordingConnection((sql) => {
      if (sql.includes("FROM outbound_messages")) {
        reads += 1;
        return [outboundRow({ status: reads === 1 ? "sending" : "sent", sent_at: reads === 1 ? null : now })];
      }
      return { affectedRows: 1 };
    });
    database.connection = recorded.connection;

    const result = await new MariaDbStateStore().markOutboundMessage("outbound-1", "sent");

    expect(result).toEqual(expect.objectContaining({ id: "outbound-1", status: "sent" }));
    expect(recorded.operations[0]).toBe("beginTransaction");
    expect(recorded.operations[1]).toBe(stateLockSql);
    const selects = recorded.calls.filter(([sql]) => sql.includes("FROM outbound_messages"));
    expect(normalizeSql(selects[0][0])).toMatch(/WHERE id = \? LIMIT 1 FOR UPDATE$/);
    expect(recorded.operations.at(-1)).toBe("commit");
  });
});
