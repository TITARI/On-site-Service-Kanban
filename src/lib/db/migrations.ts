import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DatabaseConnection } from "./connection";

export type MigrationFile = {
  version: string;
  filename: string;
  sql: string;
};

const migrationsDir = path.join(process.cwd(), "db", "migrations");

export function splitSqlStatements(sql: string) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

export async function loadMigrationFiles(dir = migrationsDir): Promise<MigrationFile[]> {
  const filenames = (await readdir(dir))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(filenames.map(async (filename) => ({
    version: filename.replace(/\.sql$/, ""),
    filename,
    sql: await readFile(path.join(dir, filename), "utf-8")
  })));
}

async function ensureMigrationTable(connection: DatabaseConnection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(64) NOT NULL PRIMARY KEY,
      applied_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedVersions(connection: DatabaseConnection) {
  await ensureMigrationTable(connection);
  const [rows] = await connection.execute<RowDataPacket[]>("SELECT version FROM schema_migrations");
  return new Set(rows.map((row) => String(row.version)));
}

export async function runMigrations(connection: DatabaseConnection, files?: MigrationFile[]) {
  const migrations = files ?? await loadMigrationFiles();
  const applied = await appliedVersions(connection);
  const appliedNow: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    for (const statement of splitSqlStatements(migration.sql)) {
      await connection.query(statement);
    }
    await connection.execute<ResultSetHeader>(
      "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      [migration.version, new Date()]
    );
    appliedNow.push(migration.version);
  }

  return appliedNow;
}
