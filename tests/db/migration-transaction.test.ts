import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import { runMigrations, splitSqlStatements, type MigrationFile } from "@/lib/db/migrations";

function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

function fakeMigrationConnection() {
  const state = { values: [] as string[], versions: [] as string[] };
  let snapshot = { values: [] as string[], versions: [] as string[] };
  let fail = true;

  const connection = {
    execute: vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("SELECT version FROM schema_migrations")) {
        return [state.versions.map((version) => ({ version }))];
      }
      if (sql.includes("INSERT INTO schema_migrations")) {
        state.versions.push(String(params[0]));
      }
      return [{ affectedRows: 1 }];
    }),
    query: vi.fn(async (sql: string) => {
      if (sql === "FAIL" && fail) throw new Error("migration failed");
      if (sql.startsWith("INSERT DATA ")) state.values.push(sql.slice("INSERT DATA ".length));
      return [{ affectedRows: 1 }];
    }),
    beginTransaction: vi.fn(async () => {
      snapshot = { values: [...state.values], versions: [...state.versions] };
    }),
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => {
      state.values = [...snapshot.values];
      state.versions = [...snapshot.versions];
    })
  } as unknown as DatabaseConnection;

  return {
    connection,
    state,
    allowSuccess: () => {
      fail = false;
    }
  };
}

const migration: MigrationFile = {
  version: "999_transaction_test",
  filename: "999_transaction_test.sql",
  sql: "INSERT DATA one;\nFAIL;"
};

describe("migration execution", () => {
  it("rolls back transactional statements and does not record a failed migration", async () => {
    const database = fakeMigrationConnection();

    await expect(runMigrations(database.connection, [migration]))
      .rejects.toThrow("migration failed");

    expect(database.state.values).toEqual([]);
    expect(database.state.versions).toEqual([]);
    expect(database.connection.rollback).toHaveBeenCalledOnce();
    expect(database.connection.commit).not.toHaveBeenCalled();
  });

  it("can rerun a failed migration without duplicating committed data", async () => {
    const database = fakeMigrationConnection();
    await expect(runMigrations(database.connection, [migration])).rejects.toThrow();

    database.allowSuccess();
    await expect(runMigrations(database.connection, [migration]))
      .resolves.toEqual([migration.version]);
    await expect(runMigrations(database.connection, [migration]))
      .resolves.toEqual([]);

    expect(database.state.values).toEqual(["one"]);
    expect(database.state.versions).toEqual([migration.version]);
  });
});

describe("splitSqlStatements", () => {
  it("keeps semicolons inside quoted literals and identifiers", () => {
    const statements = splitSqlStatements(`
      INSERT INTO notes VALUES ('first;\nsecond', "double;quoted", \`semi;colon\`);
      SELECT 'it''s; still one'; SELECT 2;
    `).map(normalizeSql);

    expect(statements).toEqual([
      normalizeSql("INSERT INTO notes VALUES ('first;\nsecond', \"double;quoted\", `semi;colon`)"),
      "SELECT 'it''s; still one'",
      "SELECT 2"
    ]);
  });

  it("ignores semicolons in line and block comments", () => {
    const statements = splitSqlStatements(`
      -- comment with ; delimiter
      SELECT 1;
      /* block ; comment */ SELECT 2;
    `).map(normalizeSql);

    expect(statements).toEqual(["SELECT 1", "SELECT 2"]);
  });
});

describe("003_user_rbac_management restart safety", () => {
  const sql = normalizeSql(readFileSync(
    path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql"),
    "utf-8"
  ));

  it("guards fallback group updates and duplicate identity cleanup", () => {
    expect(sql).toContain(normalizeSql(`
      WHERE group_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM user_groups g WHERE g.id = people.group_id
        )
    `));
    expect(sql).toContain(normalizeSql(`
      WHERE duplicate_identity.person_id IS NOT NULL
        AND keeper.person_id IS NOT NULL
    `));
  });
});
