import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const temporaryRoots: string[] = [];
const validSql = `-- migrate:up transaction:false
SELECT 1;
-- migrate:down transaction:false
SELECT 1;
`;

async function temporaryMigrationsDir() {
  const root = await mkdtemp(path.join(tmpdir(), "dbmate-tools-"));
  const migrationsDir = path.join(root, "db", "migrations");
  await mkdir(migrationsDir, { recursive: true });
  temporaryRoots.push(root);
  return migrationsDir;
}

async function writeMigration(
  migrationsDir: string,
  filename: string,
  sql = validSql
) {
  await writeFile(path.join(migrationsDir, filename), sql, "utf8");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("dbmate migration checksums", () => {
  it("seals and verifies every timestamp migration", async () => {
    const { sealMigrations, verifyMigrations } = await import("../../scripts/dbmate-checksums.mjs");
    const migrationsDir = await temporaryMigrationsDir();
    await writeMigration(migrationsDir, "20260101000001_initial.sql");

    const manifest = await sealMigrations(migrationsDir);

    expect(Object.keys(manifest.files)).toEqual(["20260101000001_initial.sql"]);
    await expect(verifyMigrations(migrationsDir)).resolves.toEqual({ count: 1 });
  });

  it("rejects a modified sealed migration", async () => {
    const { sealMigrations, verifyMigrations } = await import("../../scripts/dbmate-checksums.mjs");
    const migrationsDir = await temporaryMigrationsDir();
    const filename = "20260101000001_initial.sql";
    await writeMigration(migrationsDir, filename);
    await sealMigrations(migrationsDir);

    await appendFile(path.join(migrationsDir, filename), "SELECT 2;\n", "utf8");

    await expect(verifyMigrations(migrationsDir)).rejects.toThrow(`migration checksum mismatch: ${filename}`);
  });

  it("rejects an unsealed migration", async () => {
    const { sealMigrations, verifyMigrations } = await import("../../scripts/dbmate-checksums.mjs");
    const migrationsDir = await temporaryMigrationsDir();
    await writeMigration(migrationsDir, "20260101000001_initial.sql");
    await sealMigrations(migrationsDir);
    await writeMigration(migrationsDir, "20260101000002_extra.sql");

    await expect(verifyMigrations(migrationsDir)).rejects.toThrow("migration manifest coverage mismatch");
  });

  it("treats Git CRLF and LF checkouts as the same migration content", async () => {
    const { sealMigrations, verifyMigrations } = await import("../../scripts/dbmate-checksums.mjs");
    const migrationsDir = await temporaryMigrationsDir();
    const filename = "20260101000001_initial.sql";
    await writeMigration(migrationsDir, filename, validSql.replace(/\n/g, "\r\n"));
    await sealMigrations(migrationsDir);

    await writeMigration(migrationsDir, filename, validSql);

    await expect(verifyMigrations(migrationsDir)).resolves.toEqual({ count: 1 });
  });

  it("rejects duplicate versions and missing dbmate directives", async () => {
    const { sealMigrations } = await import("../../scripts/dbmate-checksums.mjs");
    const migrationsDir = await temporaryMigrationsDir();
    await writeMigration(migrationsDir, "20260101000001_one.sql");
    await writeMigration(migrationsDir, "20260101000001_two.sql");

    await expect(sealMigrations(migrationsDir)).rejects.toThrow("duplicate migration version: 20260101000001");

    await rm(path.join(migrationsDir, "20260101000001_two.sql"));
    await writeMigration(migrationsDir, "20260101000001_one.sql", "SELECT 1;\n");
    await expect(sealMigrations(migrationsDir)).rejects.toThrow("missing -- migrate:up directive");
  });
});

describe("legacy migration version cutover", () => {
  it("maps only present legacy versions and preserves unknown history", async () => {
    const { planLegacyVersionCutover } = await import("../../scripts/dbmate-cutover.mjs");

    const plan = planLegacyVersionCutover([
      "001_initial_schema",
      "003_wxauto_mcp",
      "20260101000002"
    ]);

    expect(plan.mappings).toEqual([
      { legacy: "001_initial_schema", dbmate: "20260101000001" }
    ]);
    expect(plan.unknownLegacyVersions).toEqual(["003_wxauto_mcp"]);
  });

  it("maps an old alias even when the timestamp version already exists", async () => {
    const { planLegacyVersionCutover } = await import("../../scripts/dbmate-cutover.mjs");

    const plan = planLegacyVersionCutover([
      "001_initial_schema",
      "20260101000001"
    ]);

    expect(plan.mappings).toEqual([
      { legacy: "001_initial_schema", dbmate: "20260101000001" }
    ]);
    expect(plan.unknownLegacyVersions).toEqual([]);
  });

  it("uses the approved timestamp mapping without inventing version 007", async () => {
    const { LEGACY_VERSION_MAP } = await import("../../scripts/dbmate-cutover.mjs");

    expect(LEGACY_VERSION_MAP).toEqual([
      { legacy: "001_initial_schema", dbmate: "20260101000001" },
      { legacy: "002_keyword_rule_sets", dbmate: "20260101000002" },
      { legacy: "003_user_rbac_management", dbmate: "20260101000003" },
      { legacy: "004_exhibitor_booth_identity", dbmate: "20260101000004" },
      { legacy: "005_ticket_optimistic_lock", dbmate: "20260101000005" },
      { legacy: "006_bootstrap_rate_limits", dbmate: "20260101000006" },
      { legacy: "008_session_kind", dbmate: "20260101000008" },
      { legacy: "009_user_version_column", dbmate: "20260101000009" }
    ]);
  });
});

describe("dbmate package commands", () => {
  it("composes verification, cutover, migration, rollback, and import fail-fast", async () => {
    const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));

    expect(packageJson.scripts).toMatchObject({
      "db:migrate": "npm run db:migrate:verify && npm run db:migrate:cutover && dbmate --no-dump-schema migrate",
      "db:migrate:new": "dbmate new",
      "db:migrate:rollback": "npm run db:migrate:verify && dbmate --no-dump-schema rollback",
      "db:migrate:status": "dbmate status",
      "db:migrate:seal": "node scripts/dbmate-checksums.mjs seal",
      "db:migrate:verify": "node scripts/dbmate-checksums.mjs verify",
      "db:migrate:cutover": "node scripts/dbmate-cutover.mjs",
      "db:import-state": "npm run db:migrate && node scripts/db-import-state.mjs"
    });
  });
});
