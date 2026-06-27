import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { DatabaseConnection } from "./connection";

export type MigrationFile = {
  version: string;
  filename: string;
  sql: string;
};

const migrationsDir = path.join(process.cwd(), "db", "migrations");

export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;

  for (let i = 0; i < sql.length;) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (quote) {
      current += ch;
      if (ch === "\\" && next !== undefined) {
        current += next;
        i += 2;
        continue;
      }
      if (ch === quote) {
        if (next === quote) {
          current += next;
          i += 2;
          continue;
        }
        quote = undefined;
      }
      i++;
      continue;
    }

    if (ch === "-" && next === "-") {
      if (current && !/\s$/.test(current)) current += " ";
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      if (current && !/\s$/.test(current)) current += " ";
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < sql.length) i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }

  const statement = current.trim();
  if (statement) statements.push(statement);
  return statements;
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

async function withMigrationTransaction<T>(
  connection: DatabaseConnection,
  operation: (transaction: PoolConnection) => Promise<T>
) {
  const ownsConnection = "getConnection" in connection;
  const transaction = ownsConnection ? await connection.getConnection() : connection;
  try {
    await transaction.beginTransaction();
    try {
      const result = await operation(transaction);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  } finally {
    if (ownsConnection) transaction.release();
  }
}

export async function runMigrations(connection: DatabaseConnection, files?: MigrationFile[]) {
  const migrations = files ?? await loadMigrationFiles();
  const applied = await appliedVersions(connection);
  const appliedNow: string[] = [];

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    // MariaDB DDL implicitly commits; those statements must also remain restart-safe.
    await withMigrationTransaction(connection, async (transaction) => {
      for (const statement of splitSqlStatements(migration.sql)) {
        await transaction.query(statement);
      }
      await transaction.execute<ResultSetHeader>(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [migration.version, new Date()]
      );
    });
    applied.add(migration.version);
    appliedNow.push(migration.version);
  }

  return appliedNow;
}
