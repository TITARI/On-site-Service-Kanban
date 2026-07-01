import { describe, expect, it, vi } from "vitest";
import { MariaDbStateStore } from "@/lib/db/mariadb-state-store";
import type { DatabaseConnection } from "@/lib/db/connection";
import { defaultConfig } from "@/lib/seed";

const aiMock = vi.hoisted(() => ({
  classifyIssue: vi.fn(),
  dedupeIssue: vi.fn()
}));

vi.mock("@/lib/ai/router", () => ({
  createAiRouter: () => aiMock
}));

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

function submitTicketConnection() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("FROM app_config_versions")) return [[]];
      if (sql.includes("FROM exhibition_booths")) return [[{
        booth_number: "A01",
        company_name: "Test Company",
        company_short_name: "Test",
        sales_owner: "Owner",
        builder: "Builder",
        raw_payload: JSON.stringify({ location: "1E", area: "36", boothType: "standard" })
      }]];
      if (sql.includes("FROM tickets")) return [[]];
      if (sql.includes("FROM ai_decisions")) return [[]];
      if (sql.includes("FROM ticket_timeline")) return [[]];
      if (sql.includes("FROM ticket_replies")) return [[]];
      if (sql.includes("FROM ticket_feedback_users")) return [[]];
      if (sql.trimStart().startsWith("SELECT")) return [[]];
      return [{ affectedRows: 1 }];
    })
  } as unknown as DatabaseConnection;
  return { calls, connection };
}

describe("submitTicket concurrency and transaction scope", () => {
  it("uses SELECT FOR UPDATE when reading open tickets for a booth", async () => {
    const { calls, connection } = submitTicketConnection();
    databaseMocks.setConnection(connection);
    aiMock.classifyIssue.mockResolvedValue({
      modelId: "fast", scenario: "classify", confidence: 0.9,
      action: "classify", issueType: "网络", latencyMs: 1
    });
    aiMock.dedupeIssue.mockResolvedValue({
      modelId: "smart", scenario: "dedupe", confidence: 0,
      action: "create", latencyMs: 1
    });

    await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    const selectCall = calls.find((call) =>
      call.sql.includes("SELECT id FROM tickets WHERE booth_number") &&
      call.sql.includes("FOR UPDATE")
    );
    expect(selectCall).toBeDefined();
  });

  it("calls classifyIssue outside the database transaction", async () => {
    const { connection } = submitTicketConnection();
    databaseMocks.setConnection(connection);
    let classifyCallTime = 0;
    let transactionStartTime = 0;
    databaseMocks.withDatabaseTransaction.mockImplementationOnce(async <T>(
      operation: (connection: DatabaseConnection) => Promise<T>
    ) => {
      transactionStartTime = Date.now();
      return operation(connection);
    });
    aiMock.classifyIssue.mockImplementation(async () => {
      classifyCallTime = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        modelId: "fast", scenario: "classify", confidence: 0.9,
        action: "classify", issueType: "网络", latencyMs: 50
      };
    });
    aiMock.dedupeIssue.mockResolvedValue({
      modelId: "smart", scenario: "dedupe", confidence: 0,
      action: "create", latencyMs: 1
    });

    await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(classifyCallTime).toBeLessThan(transactionStartTime);
  });

  it("calls dedupeIssue before opening the database transaction", async () => {
    const { connection } = submitTicketConnection();
    databaseMocks.setConnection(connection);
    const events: string[] = [];
    databaseMocks.withDatabaseTransaction.mockImplementationOnce(async <T>(
      operation: (connection: DatabaseConnection) => Promise<T>
    ) => {
      events.push("transaction-start");
      return operation(connection);
    });
    aiMock.classifyIssue.mockResolvedValue({
      modelId: "fast", scenario: "classify", confidence: 0.9,
      action: "classify", issueType: "网络", latencyMs: 1
    });
    aiMock.dedupeIssue.mockImplementation(async () => {
      events.push("dedupe");
      return {
        modelId: "smart", scenario: "dedupe", confidence: 0,
        action: "create", latencyMs: 1
      };
    });

    await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(events).toEqual(["dedupe", "transaction-start"]);
  });

  it("re-runs dedupe inside the transaction when locked candidates changed", async () => {
    let ticketIdSelectCount = 0;
    const connection = {
      execute: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM app_config_versions")) return [[]];
        if (sql.includes("FROM exhibition_booths")) return [[{
          booth_number: "A01",
          company_name: "Test Company",
          company_short_name: "Test",
          sales_owner: "Owner",
          builder: "Builder",
          raw_payload: JSON.stringify({ location: "1E", area: "36", boothType: "standard" })
        }]];
        if (sql.includes("SELECT id FROM tickets WHERE booth_number")) {
          ticketIdSelectCount += 1;
          return ticketIdSelectCount === 1 ? [[]] : [[{ id: "ticket-existing" }]];
        }
        if (sql.includes("SELECT * FROM tickets WHERE id")) return [[{
          id: "ticket-existing",
          title: "A01 Test 网络",
          booth_number: "A01",
          company_name: "Test Company",
          company_short_name: "Test",
          description: "网络断了",
          image_urls: "[]",
          issue_type: "网络",
          submitter_id: "u0",
          submitter_name: "王五",
          status: "待受理",
          assignment_group: "it",
          urge_count: 0,
          urge_level: 0,
          priority_score: 1,
          created_at: new Date("2026-01-01T00:00:00.000Z"),
          updated_at: new Date("2026-01-01T00:00:00.000Z")
        }]];
        if (sql.includes("FROM ai_decisions")) return [[]];
        if (sql.includes("FROM ticket_timeline")) return [[]];
        if (sql.includes("FROM ticket_replies")) return [[]];
        if (sql.includes("FROM ticket_feedback_users")) return [[]];
        if (sql.trimStart().startsWith("SELECT")) return [[]];
        return [{ affectedRows: 1 }];
      })
    } as unknown as DatabaseConnection;
    databaseMocks.setConnection(connection);
    const events: string[] = [];
    databaseMocks.withDatabaseTransaction.mockImplementationOnce(async <T>(
      operation: (connection: DatabaseConnection) => Promise<T>
    ) => {
      events.push("transaction-start");
      return operation(connection);
    });
    aiMock.classifyIssue.mockResolvedValue({
      modelId: "fast", scenario: "classify", confidence: 0.9,
      action: "classify", issueType: "网络", latencyMs: 1
    });
    aiMock.dedupeIssue.mockImplementation(async (_boothNumber, _description, candidates) => {
      events.push(`dedupe:${candidates.length}`);
      return candidates.length === 0
        ? {
            modelId: "smart", scenario: "dedupe", confidence: 0,
            action: "create", latencyMs: 1
          }
        : {
            modelId: "smart", scenario: "dedupe", confidence: 0.95,
            action: "urge", matchedTicketId: "ticket-existing", latencyMs: 1
          };
    });

    const result = await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(events).toEqual(["dedupe:0", "transaction-start", "dedupe:1"]);
    expect(result.kind).toBe("urged");
  });

  it("falls back to 综合服务 when classifyIssue throws outside the transaction", async () => {
    const { connection } = submitTicketConnection();
    databaseMocks.setConnection(connection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockRejectedValue(new Error("AI down"));
    aiMock.dedupeIssue.mockResolvedValue({
      modelId: "smart", scenario: "dedupe", confidence: 0,
      action: "create", latencyMs: 1
    });

    const result = await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(result.kind).toBe("created");
    expect(result.ticket.issueType).toBe("综合服务");
  });

  it("falls back to create when precomputed dedupeIssue throws", async () => {
    const { connection } = submitTicketConnection();
    databaseMocks.setConnection(connection);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    aiMock.classifyIssue.mockResolvedValue({
      modelId: "fast", scenario: "classify", confidence: 0.9,
      action: "classify", issueType: "网络", latencyMs: 1
    });
    aiMock.dedupeIssue.mockRejectedValue(new Error("AI down"));

    const result = await new MariaDbStateStore().submitTicket({
      boothNumber: "A01",
      description: "网络断了",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(result.kind).toBe("created");
  });
});
