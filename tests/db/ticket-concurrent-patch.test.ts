import { describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";
import type { Ticket } from "@/lib/domain/types";

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

function date(value: string) {
  return new Date(value);
}

function concurrentPatchConnection() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM tickets")) return [[{
        id: "ticket-1",
        title: "A01 网络故障",
        booth_number: "A01",
        company_name: "测试公司",
        company_short_name: "测试",
        description: "网络断开",
        image_urls: JSON.stringify([]),
        issue_type: "网络",
        submitter_id: "submitter-1",
        submitter_name: "张三",
        submitter_phone: "13800138000",
        reporter_person_id: null,
        reporter_chat_identity_id: null,
        source_conversation_id: null,
        status: "处理中",
        accepted_at: null,
        handler_id: "handler-1",
        handler_name: "李四",
        handler_phone: null,
        assignment_group: "网络组",
        urge_count: 0,
        last_urged_at: null,
        urge_level: 0,
        priority_score: 0,
        version: 0,
        created_at: date("2026-06-01T00:00:00.000Z"),
        updated_at: date("2026-06-01T00:01:00.000Z")
      }]];
      if (sql.includes("FROM ticket_feedback_users")) return [[{
        ticket_id: "ticket-1",
        user_id: "submitter-1",
        user_name: "张三",
        phone: "13800138000",
        feedback_at: date("2026-06-01T00:00:00.000Z")
      }]];
      if (sql.includes("FROM ticket_replies")) return [[{
        id: "reply-1",
        ticket_id: "ticket-1",
        author_id: "submitter-1",
        author_name: "张三",
        author_phone: "13800138000",
        role: "member",
        body: "请处理",
        image_urls: JSON.stringify([]),
        created_at: date("2026-06-01T00:00:00.000Z")
      }]];
      if (sql.includes("FROM ticket_timeline")) return [[
        {
          id: "timeline-1",
          ticket_id: "ticket-1",
          type: "submitted",
          body: "提交工单",
          actor_name: "张三",
          to_status: null,
          created_at: date("2026-06-01T00:00:00.000Z")
        },
        {
          id: "timeline-2",
          ticket_id: "ticket-1",
          type: "status-changed",
          body: "状态变更为处理中",
          actor_name: "李四",
          to_status: "处理中",
          created_at: date("2026-06-01T00:01:00.000Z")
        }
      ]];
      if (sql.includes("FROM ai_decisions")) return [[]];
      if (sql.trimStart().startsWith("SELECT")) return [[]];
      return [{ affectedRows: 1 }];
    })
  } as unknown as DatabaseConnection;
  return { calls, connection };
}

function appendPatch(ticket: Ticket, suffix: "a" | "b") {
  const createdAt = suffix === "a"
    ? "2026-06-01T00:02:00.000Z"
    : "2026-06-01T00:03:00.000Z";
  ticket.timeline.push({
    id: `timeline-${suffix}`,
    ticketId: ticket.id,
    type: "status-changed",
    body: "状态变更为已解决",
    actorName: `处理人-${suffix}`,
    toStatus: "已解决",
    createdAt
  });
  ticket.replies.push({
    id: `reply-${suffix}`,
    ticketId: ticket.id,
    authorId: `handler-${suffix}`,
    authorName: `处理人-${suffix}`,
    role: "handler",
    body: `处理完成-${suffix}`,
    imageUrls: [`/uploads/${suffix}.jpg`],
    createdAt
  });
  ticket.feedbackUsers.push({
    userId: `feedback-${suffix}`,
    userName: `反馈人-${suffix}`,
    phone: `1390000000${suffix === "a" ? 1 : 2}`,
    feedbackAt: createdAt
  });
  ticket.aiDecisions.push({
    modelId: "smart",
    provider: "mock",
    scenario: "dedupe",
    confidence: 0,
    action: "create",
    latencyMs: 1
  });
  ticket.updatedAt = createdAt;
}

describe("MariaDB ticket graph concurrent patch persistence", () => {
  it("appends child rows incrementally instead of deleting and reinserting the graph", async () => {
    const { calls, connection } = concurrentPatchConnection();
    databaseMocks.setConnection(connection);
    const store = new MariaDbStateStore();

    const patchA = await store.getTicket("ticket-1");
    const patchB = await store.getTicket("ticket-1");
    expect(patchA).toBeDefined();
    expect(patchB).toBeDefined();

    appendPatch(patchA!, "a");
    appendPatch(patchB!, "b");

    await store.saveTicket(patchA!);
    await store.saveTicket(patchB!);

    expect(calls.some((call) => call.sql.trimStart().startsWith("DELETE"))).toBe(false);

    const timelineInserts = calls.filter((call) => call.sql.includes("INSERT IGNORE INTO ticket_timeline"));
    expect(timelineInserts.map((call) => call.params[0])).toEqual(expect.arrayContaining(["timeline-a", "timeline-b"]));
    expect(timelineInserts.find((call) => call.params[0] === "timeline-a")?.sql).toContain("to_status");
    expect(timelineInserts.find((call) => call.params[0] === "timeline-a")?.params).toContain("已解决");

    const replyInserts = calls.filter((call) => call.sql.includes("INSERT IGNORE INTO ticket_replies"));
    expect(replyInserts.map((call) => call.params[0])).toEqual(expect.arrayContaining(["reply-a", "reply-b"]));

    const feedbackInserts = calls.filter((call) => call.sql.includes("INSERT IGNORE INTO ticket_feedback_users"));
    expect(feedbackInserts.map((call) => call.params[2])).toEqual(expect.arrayContaining(["feedback-a", "feedback-b"]));

    const decisionInsert = calls.find((call) => call.sql.includes("INSERT IGNORE INTO ai_decisions"));
    expect(decisionInsert?.sql).toContain("provider");
    expect(decisionInsert?.params).toContain("mock");

    const ticketUpserts = calls.filter((call) => call.sql.includes("INSERT INTO tickets"));
    expect(ticketUpserts.at(-1)?.sql).toContain("version");
  });
});
