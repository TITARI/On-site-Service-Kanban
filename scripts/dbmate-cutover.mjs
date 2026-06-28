import { pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

export const LEGACY_VERSION_MAP = Object.freeze([
  ["001_initial_schema", "20260101000001"],
  ["002_keyword_rule_sets", "20260101000002"],
  ["003_user_rbac_management", "20260101000003"],
  ["004_exhibitor_booth_identity", "20260101000004"],
  ["005_ticket_optimistic_lock", "20260101000005"],
  ["006_bootstrap_rate_limits", "20260101000006"],
  ["008_session_kind", "20260101000008"],
  ["009_user_version_column", "20260101000009"]
].map(([legacy, dbmate]) => Object.freeze({ legacy, dbmate })));

export function planLegacyVersionCutover(appliedVersions) {
  const applied = new Set(appliedVersions.map(String));
  const knownLegacyVersions = new Set(LEGACY_VERSION_MAP.map(({ legacy }) => legacy));
  return {
    mappings: LEGACY_VERSION_MAP.filter(({ legacy }) => applied.has(legacy)),
    unknownLegacyVersions: [...applied]
      .filter((version) => !/^\d{14}$/.test(version) && !knownLegacyVersions.has(version))
      .sort((left, right) => left.localeCompare(right))
  };
}

async function migrationTableExists(connection) {
  const [rows] = await connection.query(`
    SELECT 1 AS present
    FROM information_schema.tables
    WHERE table_schema = DATABASE()
      AND table_name = 'schema_migrations'
    LIMIT 1
  `);
  return rows.length > 0;
}

async function hasAppliedAtColumn(connection) {
  const [rows] = await connection.query("SHOW COLUMNS FROM schema_migrations");
  return rows.some((row) => String(row.Field) === "applied_at");
}

async function readAppliedVersions(connection) {
  const [rows] = await connection.query("SELECT version FROM schema_migrations ORDER BY version");
  return rows.map((row) => String(row.version));
}

export async function cutoverLegacyVersions({ databaseUrl = process.env.DATABASE_URL } = {}) {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const connection = await mysql.createConnection({ uri: databaseUrl, timezone: "Z" });

  try {
    if (!await migrationTableExists(connection)) {
      return { mappings: [], unknownLegacyVersions: [] };
    }

    const appliedVersions = await readAppliedVersions(connection);
    const plan = planLegacyVersionCutover(appliedVersions);
    if (plan.mappings.length === 0) return plan;
    const preserveAppliedAt = await hasAppliedAtColumn(connection);
    const insertSql = preserveAppliedAt
      ? `
          INSERT INTO schema_migrations (version, applied_at)
          SELECT ?, applied_at FROM schema_migrations WHERE version = ?
          ON DUPLICATE KEY UPDATE version = VALUES(version)
        `
      : `
          INSERT INTO schema_migrations (version)
          SELECT ? FROM schema_migrations WHERE version = ?
          ON DUPLICATE KEY UPDATE version = VALUES(version)
        `;

    await connection.beginTransaction();
    try {
      for (const { legacy, dbmate } of plan.mappings) {
        await connection.execute(insertSql, [dbmate, legacy]);
        await connection.execute("DELETE FROM schema_migrations WHERE version = ?", [legacy]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    }

    return plan;
  } finally {
    await connection.end();
  }
}

async function main() {
  const result = await cutoverLegacyVersions();
  console.log(`Mapped ${result.mappings.length} legacy migration version(s).`);
  if (result.unknownLegacyVersions.length > 0) {
    console.log(`Preserved unknown legacy versions: ${result.unknownLegacyVersions.join(", ")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
