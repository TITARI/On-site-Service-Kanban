import type { RowDataPacket } from "mysql2/promise";
import type { DatabaseConnection } from "./connection";

/**
 * @deprecated 此模块仅用于读取已应用的迁移历史。
 * 新迁移请使用 dbmate（`npm run db:migrate`）。
 */
export async function readAppliedMigrationVersions(connection: DatabaseConnection) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return rows.map((row) => String(row.version)).sort((left, right) => left.localeCompare(right));
}
