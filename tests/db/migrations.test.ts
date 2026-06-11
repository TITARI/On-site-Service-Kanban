import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseConnection } from "@/lib/db/connection";
import { runMigrations } from "@/lib/db/migrations";

function retryableMigrationConnection() {
  const appliedOperations = new Set<string>();
  let migrationRecorded = false;
  let failAfterStatements = true;

  const execute = vi.fn(async (sql: string) => {
    if (sql.includes("SELECT version FROM schema_migrations")) {
      return [migrationRecorded ? [{ version: "003_user_rbac_management" }] : []];
    }
    if (sql.includes("INSERT INTO schema_migrations")) {
      migrationRecorded = true;
    }
    return [{ affectedRows: 1 }];
  });

  const query = vi.fn(async (sql: string) => {
    if (sql === "SELECT fail_once") {
      if (failAfterStatements) {
        failAfterStatements = false;
        throw new Error("simulated later migration failure");
      }
      return [[]];
    }

    const compact = sql.replace(/\s+/g, " ").trim();
    const table = compact.match(/^ALTER TABLE ([a-z_]+)/)?.[1];
    if (!table) return [[]];

    for (const match of compact.matchAll(/ADD COLUMN( IF NOT EXISTS)? ([a-z_]+)/g)) {
      const operation = `${table}.column.${match[2]}`;
      if (appliedOperations.has(operation) && !match[1]) throw new Error(`duplicate column ${operation}`);
      appliedOperations.add(operation);
    }
    for (const match of compact.matchAll(/ADD UNIQUE KEY( IF NOT EXISTS)? ([a-z_]+)/g)) {
      const operation = `${table}.index.${match[2]}`;
      if (appliedOperations.has(operation) && !match[1]) throw new Error(`duplicate index ${operation}`);
      appliedOperations.add(operation);
    }
    return [[]];
  });

  return {
    connection: { execute, query } as unknown as DatabaseConnection,
    query
  };
}

describe("runMigrations", () => {
  it("can rerun 003 after all statements applied but a later failure prevented version recording", async () => {
    const sql = readFileSync(
      path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql"),
      "utf-8"
    );
    const migration = {
      version: "003_user_rbac_management",
      filename: "003_user_rbac_management.sql",
      sql: `${sql}\nSELECT fail_once;\n`
    };
    const { connection, query } = retryableMigrationConnection();

    await expect(runMigrations(connection, [migration])).rejects.toThrow("simulated later migration failure");
    await expect(runMigrations(connection, [migration])).resolves.toEqual(["003_user_rbac_management"]);

    const callsAfterRetry = query.mock.calls.length;
    await expect(runMigrations(connection, [migration])).resolves.toEqual([]);
    expect(query).toHaveBeenCalledTimes(callsAfterRetry);
  });
});
