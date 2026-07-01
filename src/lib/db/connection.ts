import { createPool, type Pool as CallbackPool } from "mysql2";
import type { Pool, PoolConnection } from "mysql2/promise";

export type DatabaseConnection = Pool | PoolConnection;

let callbackPool: CallbackPool | undefined;
let pool: Pool | undefined;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not configured");
  return url;
}

export function createDatabaseCallbackPool(url = databaseUrl()) {
  return createPool({
    uri: url,
    connectionLimit: 10,
    waitForConnections: true,
    namedPlaceholders: false,
    charset: "utf8mb4_unicode_ci",
    timezone: "Z",
    dateStrings: false
  });
}

export function createDatabasePool(url = databaseUrl()) {
  return createDatabaseCallbackPool(url).promise();
}

function initializeDatabasePool() {
  if (!callbackPool) {
    callbackPool = createDatabaseCallbackPool();
    pool = callbackPool.promise();
  }
}

export function getDatabaseCallbackPool() {
  initializeDatabasePool();
  return callbackPool as CallbackPool;
}

export function getDatabasePool() {
  initializeDatabasePool();
  return pool as Pool;
}

export async function closeDatabasePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
  callbackPool = undefined;
}

export async function withDatabaseConnection<T>(fn: (connection: PoolConnection) => Promise<T>) {
  const connection = await getDatabasePool().getConnection();
  try {
    return await fn(connection);
  } finally {
    connection.release();
  }
}

export async function withDatabaseTransaction<T>(fn: (connection: PoolConnection) => Promise<T>) {
  return withDatabaseConnection(async (connection) => {
    await connection.beginTransaction();
    try {
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  });
}
