import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultMigrationsDir = path.join(rootDir, "db", "migrations");

export function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let quote;

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

export async function loadMigrationFiles(migrationsDir = defaultMigrationsDir) {
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => /^\d+_.+\.sql$/.test(filename))
    .sort((a, b) => a.localeCompare(b));

  return Promise.all(filenames.map(async (filename) => ({
    version: filename.replace(/\.sql$/, ""),
    filename,
    sql: await readFile(path.join(migrationsDir, filename), "utf-8")
  })));
}

async function ensureMigrationTable(connection) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version varchar(64) NOT NULL PRIMARY KEY,
      applied_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function appliedVersions(connection) {
  await ensureMigrationTable(connection);
  const [rows] = await connection.execute("SELECT version FROM schema_migrations");
  return new Set(rows.map((row) => String(row.version)));
}

export async function runMigrations({ databaseUrl = process.env.DATABASE_URL, migrationsDir = defaultMigrationsDir } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = mysql.createPool({
    uri: databaseUrl,
    connectionLimit: 1,
    waitForConnections: true,
    timezone: "Z"
  });
  const connection = await pool.getConnection();

  try {
    const migrations = await loadMigrationFiles(migrationsDir);
    const applied = await appliedVersions(connection);
    const appliedNow = [];

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      // MariaDB DDL implicitly commits; those statements must also remain restart-safe.
      await connection.beginTransaction();
      try {
        for (const statement of splitSqlStatements(migration.sql)) {
          await connection.query(statement);
        }
        await connection.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [migration.version, new Date()]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
      applied.add(migration.version);
      appliedNow.push(migration.version);
    }

    return appliedNow;
  } finally {
    connection.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMigrations()
    .then((applied) => {
      if (applied.length === 0) {
        console.log("Database is already up to date.");
      } else {
        console.log(`Applied migrations: ${applied.join(", ")}`);
      }
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
