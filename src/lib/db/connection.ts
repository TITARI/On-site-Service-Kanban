import mysql, { type Pool, type PoolConnection } from "mysql2/promise";

export type DatabaseConnection = Pool | PoolConnection;

let pool: Pool | undefined;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not configured");
  return url;
}

export function createDatabasePool(url = databaseUrl()) {
  return mysql.createPool({
    uri: url,
    connectionLimit: 10,
    waitForConnections: true,
    namedPlaceholders: false,
    timezone: "Z",
    dateStrings: false
  });
}

export function getDatabasePool() {
  pool ??= createDatabasePool();
  return pool;
}

export async function closeDatabasePool() {
  if (!pool) return;
  await pool.end();
  pool = undefined;
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
