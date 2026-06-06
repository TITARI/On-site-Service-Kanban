import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolConnection } from "mysql2/promise";
import type { AppState } from "@/lib/domain/app-state";
import { defaultConfig } from "@/lib/seed";

const database = vi.hoisted(() => ({
  connection: undefined as PoolConnection | undefined
}));

vi.mock("@/lib/db/connection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/connection")>();
  return {
    ...actual,
    withDatabaseTransaction: async <T>(work: (connection: PoolConnection) => Promise<T>) => {
      const connection = database.connection;
      if (!connection) throw new Error("test database connection is not configured");
      await connection.beginTransaction();
      try {
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  };
});

const stateLockSql = "SELECT name FROM wxauto_integration_locks WHERE name = 'state-write' FOR UPDATE";

function emptyState(): AppState {
  return {
    booths: [],
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

function recordingConnection() {
  const operations: string[] = [];
  const execute = vi.fn(async (sql: string) => {
    operations.push(sql.replace(/\s+/g, " ").trim());
    if (sql.includes("FROM wxauto_integration_locks")) {
      return [[{ name: "state-write" }]];
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
    operations
  };
}

beforeEach(() => {
  database.connection = undefined;
});

describe("db import stable ids", () => {
  it("does not collide for long ids with the same prefix", async () => {
    const { stableId } = await import("../../scripts/db-import-state.mjs");

    const first = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:mobile-user");
    const second = stableId("feedback", "ticket-fb63d144-5279-4587-8e67-3cda23558b2f:smoke-user-2");

    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(second.length).toBeLessThanOrEqual(64);
  });
});

describe("MariaDbStateStore import", () => {
  it("locks the shared state row before replacing full state", async () => {
    const { connection, operations } = recordingConnection();
    database.connection = connection;
    const { MariaDbStateStore } = await import("@/lib/db/mariadb-state-store");
    const store = new MariaDbStateStore();
    vi.spyOn(store, "writeState").mockImplementation(async () => {
      operations.push("writeState");
    });

    await store.importState(emptyState(), "test-state.json");

    expect(operations[0]).toBe("beginTransaction");
    expect(operations[1]).toBe(stateLockSql);
    expect(operations[2]).toBe("writeState");
    expect(operations.at(-1)).toBe("commit");
  });
});
