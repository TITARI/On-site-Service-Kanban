import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";

type MessageRow = {
  id: string;
  channel: "wechat";
  target_conversation_id: string;
  target_chat_identity_id: null;
  target_name: string;
  text: string;
  related_ticket_id: null;
  related_session_id: null;
  status: "pending" | "sending" | "failed";
  retry_count: number;
  last_error: null;
  claimed_at: Date | null;
  sent_at: null;
  created_at: Date;
  updated_at: Date;
};

const databaseMocks = vi.hoisted(() => {
  let runTransaction: (operation: (connection: DatabaseConnection) => Promise<unknown>) => Promise<unknown>;
  return {
    setRunner: (runner: typeof runTransaction) => {
      runTransaction = runner;
    },
    withDatabaseTransaction: vi.fn(<T>(operation: (connection: DatabaseConnection) => Promise<T>) => (
      runTransaction(operation) as Promise<T>
    ))
  };
});

vi.mock("@/lib/db/connection", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/connection")>("@/lib/db/connection");
  return {
    ...actual,
    withDatabaseTransaction: databaseMocks.withDatabaseTransaction
  };
});

function message(id: string, overrides: Partial<MessageRow> = {}): MessageRow {
  const createdAt = new Date(`2026-06-01T00:00:0${id.at(-1) ?? "0"}.000Z`);
  return {
    id,
    channel: "wechat",
    target_conversation_id: "group-1",
    target_chat_identity_id: null,
    target_name: "现场群",
    text: `message-${id}`,
    related_ticket_id: null,
    related_session_id: null,
    status: "pending",
    retry_count: 0,
    last_error: null,
    claimed_at: null,
    sent_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides
  };
}

function fakeDatabase(initialRows: MessageRow[]) {
  const messageRows = initialRows.map((row) => ({ ...row }));
  const locks = new Map<string, number>();
  let transactionId = 0;

  const runTransaction = async <T>(operation: (connection: DatabaseConnection) => Promise<T>) => {
    const owner = ++transactionId;
    const connection = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM outbound_messages") && sql.includes("ORDER BY created_at")) {
          const staleCutoff = params[0] as Date;
          const limit = Number(params[1]);
          const skipLocked = sql.includes("FOR UPDATE SKIP LOCKED");
          const candidates = messageRows
            .filter((row) => (
              row.status === "pending" ||
              (row.status === "failed" && row.retry_count < 3) ||
              (row.status === "sending" && row.claimed_at !== null && row.claimed_at <= staleCutoff)
            ))
            .filter((row) => !skipLocked || !locks.has(row.id))
            .sort((left, right) => left.created_at.getTime() - right.created_at.getTime())
            .slice(0, limit);
          if (skipLocked) candidates.forEach((row) => locks.set(row.id, owner));
          await new Promise((resolve) => setTimeout(resolve, 0));
          return [candidates.map((row) => sql.includes("SELECT id") ? { id: row.id } : { ...row })];
        }

        if (sql.startsWith("UPDATE outbound_messages")) {
          const row = messageRows.find((item) => item.id === params[2]);
          const staleCutoff = params[3] as Date | undefined;
          const claimable = row && (!staleCutoff ||
            row.status === "pending" ||
            (row.status === "failed" && row.retry_count < 3) ||
            (row.status === "sending" && row.claimed_at !== null && row.claimed_at <= staleCutoff));
          if (!row || !claimable) return [{ affectedRows: 0 }];
          row.status = "sending";
          row.claimed_at = params[0] as Date;
          row.updated_at = params[1] as Date;
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("FROM outbound_messages WHERE id = ?")) {
          const row = messageRows.find((item) => item.id === params[0]);
          return [row ? [{ ...row }] : []];
        }

        return [[]];
      })
    } as unknown as DatabaseConnection;

    try {
      return await operation(connection);
    } finally {
      for (const [id, lockOwner] of locks) {
        if (lockOwner === owner) locks.delete(id);
      }
    }
  };

  return { runTransaction };
}

describe("MariaDbStateStore.claimOutboundMessages concurrency", () => {
  it("does not return overlapping messages to concurrent workers", async () => {
    const database = fakeDatabase([message("message-1"), message("message-2")]);
    databaseMocks.setRunner(database.runTransaction);
    const store = new MariaDbStateStore();

    const [first, second] = await Promise.all([
      store.claimOutboundMessages(1),
      store.claimOutboundMessages(1)
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it("reclaims stale sending messages but skips exhausted failures", async () => {
    const database = fakeDatabase([
      message("message-1", { status: "sending", claimed_at: new Date("2020-01-01T00:00:00.000Z") }),
      message("message-2", { status: "failed", retry_count: 3 })
    ]);
    databaseMocks.setRunner(database.runTransaction);

    const claimed = await new MariaDbStateStore().claimOutboundMessages(10);

    expect(claimed.map((item) => item.id)).toEqual(["message-1"]);
  });
});
