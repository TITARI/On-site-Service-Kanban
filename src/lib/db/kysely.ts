import { Kysely, MysqlDialect } from "kysely";
import { createPool } from "mysql2";
import { databaseUrl } from "./connection";
import type { Database } from "./types";

function createDialect(url: string) {
  return new MysqlDialect({
    pool: async () => createPool({
      uri: url,
      connectionLimit: 10,
      waitForConnections: true,
      namedPlaceholders: false,
      charset: "utf8mb4_unicode_ci",
      timezone: "Z",
      dateStrings: false
    })
  });
}

export function createKysely(url = databaseUrl()) {
  return new Kysely<Database>({
    dialect: createDialect(url)
  });
}

let database: Kysely<Database> | undefined;

export function getKysely() {
  database ??= createKysely();
  return database;
}

export async function closeKysely() {
  const current = database;
  database = undefined;
  await current?.destroy();
}
