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
  status: "sending" | "sent" | "failed";
  retry_count: number;
  last_error: string | null;
  claimed_at: Date;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const databaseMocks = vi.hoisted(() => {
  let connection: DatabaseConnection;
  return {
    getDatabasePool: vi.fn(() => connection),
    setConnection: (next: DatabaseConnection) => {
      connection = next;
    }
  };
});

vi.mock("@/lib/db/connection", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/connection")>("@/lib/db/connection");
  return { ...actual, getDatabasePool: databaseMocks.getDatabasePool };
});

function message(status: MessageRow["status"] = "sending"): MessageRow {
  const now = new Date("2026-06-01T00:00:00.000Z");
  return {
    id: "message-1",
    channel: "wechat",
    target_conversation_id: "group-1",
    target_chat_identity_id: null,
    target_name: "现场群",
    text: "处理完成",
    related_ticket_id: null,
    related_session_id: null,
    status,
    retry_count: 0,
    last_error: null,
    claimed_at: now,
    sent_at: status === "sent" ? now : null,
    created_at: now,
    updated_at: now
  };
}

function fakeConnection(initial?: MessageRow) {
  let row = initial ? { ...initial } : undefined;
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith("SELECT * FROM outbound_messages")) {
        const snapshot = row ? { ...row } : undefined;
        await new Promise((resolve) => setTimeout(resolve, 0));
        return [snapshot ? [snapshot] : []];
      }

      if (sql.startsWith("UPDATE outbound_messages")) {
        const nextStatus = sql.includes("status = 'sent'") ? "sent" : "failed";
        await new Promise((resolve) => setTimeout(resolve, nextStatus === "sent" ? 0 : 5));
        if (!row || (sql.includes("AND status = 'sending'") && row.status !== "sending")) {
          return [{ affectedRows: 0 }];
        }
        row.status = nextStatus;
        row.updated_at = params[1] as Date;
        if (nextStatus === "sent") {
          row.sent_at = params[0] as Date;
          row.last_error = null;
        } else {
          row.retry_count += 1;
          row.last_error = params[0] as string | null;
        }
        return [{ affectedRows: 1 }];
      }

      return [[]];
    })
  } as unknown as DatabaseConnection;

  return { connection, current: () => row };
}

describe("MariaDbStateStore.markOutboundMessage concurrency", () => {
  it("allows only one concurrent sent/failed transition", async () => {
    const database = fakeConnection(message());
    databaseMocks.setConnection(database.connection);
    const store = new MariaDbStateStore();

    const results = await Promise.all([
      store.markOutboundMessage("message-1", "sent"),
      store.markOutboundMessage("message-1", "failed", "timeout")
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(database.current()).toEqual(expect.objectContaining({
      status: "sent",
      retry_count: 0
    }));
  });

  it("returns undefined when an already sent message is marked again", async () => {
    const database = fakeConnection(message("sent"));
    databaseMocks.setConnection(database.connection);

    await expect(new MariaDbStateStore().markOutboundMessage("message-1", "failed"))
      .resolves.toBeUndefined();
    expect(database.current()?.status).toBe("sent");
  });

  it("returns undefined for a missing message", async () => {
    const database = fakeConnection();
    databaseMocks.setConnection(database.connection);

    await expect(new MariaDbStateStore().markOutboundMessage("missing", "sent"))
      .resolves.toBeUndefined();
  });
});
