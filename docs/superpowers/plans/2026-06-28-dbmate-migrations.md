# Dbmate Migration Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the duplicated Node SQL migration runner with dbmate while preserving legacy MariaDB history and enforcing migration-file checksums.

**Architecture:** Dbmate becomes the sole migration executor. Two narrow Node tools verify immutable migration bytes and perform an idempotent metadata-only legacy version cutover; neither tool parses or executes migration SQL. Package scripts compose verification, cutover, dbmate, and state import into fail-fast workflows.

**Tech Stack:** Node.js 24, npm, dbmate 2.33.0, MariaDB/mysql2, Vitest 4, TypeScript 6.

---

## File map

- Create `scripts/dbmate-checksums.mjs`: deterministic SHA-256 seal and verify commands.
- Create `scripts/dbmate-cutover.mjs`: legacy `schema_migrations` metadata conversion.
- Create `db/migrations/checksums.json`: committed migration integrity manifest.
- Create `tests/db/dbmate-tools.test.ts`: checksum, format, and cutover unit tests.
- Rename all eight `db/migrations/*.sql` files to timestamp versions and add dbmate directives.
- Modify `src/lib/db/migrations.ts`: deprecated read-only history query only.
- Delete `scripts/db-migrate.mjs`: remove the duplicate executor.
- Modify `scripts/db-import-state.mjs`: remove direct migration-runner coupling.
- Modify `tests/db/migration-schema.test.ts`: timestamp filenames and up-section assertions.
- Modify `tests/db/migration-transaction.test.ts`: replace runner transaction tests with read-only history tests.
- Modify `package.json` and `package-lock.json`: dbmate dependency and migration commands.
- Modify `README.md`: commands, filenames, cutover, sealing, and rollback policy.
- Keep the approved design and this plan in the final single commit.

### Task 1: Establish baseline and install dbmate

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Run clean baseline**

Run:

```powershell
npm.cmd ci
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
```

Expected: 91 test files and 742 tests pass; build exits 0; audit matches the branch baseline.

- [ ] **Step 2: Install exact official npm package**

Run:

```powershell
npm.cmd install --save-dev --save-exact dbmate@2.33.0
npx.cmd dbmate --version
```

Expected: dbmate reports `2.33.0` and only package metadata changes.

### Task 2: Build the checksum guard with TDD

**Files:**
- Create: `scripts/dbmate-checksums.mjs`
- Create: `tests/db/dbmate-tools.test.ts`
- Create: `db/migrations/checksums.json`

- [ ] **Step 1: Write failing checksum tests**

Create tests that import these exact exports:

```js
import {
  sealMigrations,
  verifyMigrations
} from "../../scripts/dbmate-checksums.mjs";
```

Cover these cases with temporary directories:

```js
it("seals and verifies every timestamp migration", async () => {
  await writeMigration("20260101000001_initial.sql", validSql);
  const manifest = await sealMigrations(migrationsDir);
  expect(Object.keys(manifest.files)).toEqual(["20260101000001_initial.sql"]);
  await expect(verifyMigrations(migrationsDir)).resolves.toMatchObject({ count: 1 });
});

it("rejects tampered and unsealed migration files", async () => {
  await writeMigration("20260101000001_initial.sql", validSql);
  await sealMigrations(migrationsDir);
  await appendFile(join(migrationsDir, "20260101000001_initial.sql"), "SELECT 2;\n");
  await expect(verifyMigrations(migrationsDir)).rejects.toThrow("checksum mismatch");
  await writeMigration("20260101000002_extra.sql", validSql);
  await expect(verifyMigrations(migrationsDir)).rejects.toThrow("manifest coverage");
});

it("rejects duplicate versions and missing directives", async () => {
  await writeMigration("20260101000001_one.sql", validSql);
  await writeMigration("20260101000001_two.sql", validSql);
  await expect(sealMigrations(migrationsDir)).rejects.toThrow("duplicate migration version");
  await rm(join(migrationsDir, "20260101000001_two.sql"));
  await writeFile(join(migrationsDir, "20260101000001_one.sql"), "SELECT 1;\n");
  await expect(sealMigrations(migrationsDir)).rejects.toThrow("migrate:up");
});
```

- [ ] **Step 2: Run tests and verify red state**

Run:

```powershell
npm.cmd run test:run -- tests/db/dbmate-tools.test.ts
```

Expected: FAIL because `scripts/dbmate-checksums.mjs` does not exist.

- [ ] **Step 3: Implement byte-only checksum tool**

Implement these behaviors:

```js
const MIGRATION_NAME = /^(\d{14})_[a-z0-9][a-z0-9_]*\.sql$/;

export async function sealMigrations(migrationsDir = defaultMigrationsDir) {
  const migrations = await inspectMigrations(migrationsDir);
  const manifest = {
    algorithm: "sha256",
    files: Object.fromEntries(migrations.map(({ filename, checksum }) => [filename, checksum]))
  };
  await writeFile(manifestPath(migrationsDir), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export async function verifyMigrations(migrationsDir = defaultMigrationsDir) {
  const migrations = await inspectMigrations(migrationsDir);
  const manifest = JSON.parse(await readFile(manifestPath(migrationsDir), "utf8"));
  const actualNames = migrations.map(({ filename }) => filename);
  const sealedNames = Object.keys(manifest.files).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(sealedNames)) {
    throw new Error("migration manifest coverage mismatch");
  }
  for (const migration of migrations) {
    if (manifest.files[migration.filename] !== migration.checksum) {
      throw new Error(`migration checksum mismatch: ${migration.filename}`);
    }
  }
  return { count: migrations.length };
}
```

`inspectMigrations` must sort filenames, reject duplicate 14-digit versions, require `-- migrate:up` and `-- migrate:down` at line starts, normalize CRLF to LF, and hash the resulting UTF-8 bytes with SHA-256. The CLI accepts only `seal` and `verify` and exits nonzero on errors.

- [ ] **Step 4: Run checksum tests green**

Run:

```powershell
npm.cmd run test:run -- tests/db/dbmate-tools.test.ts
```

Expected: checksum tests pass.

### Task 3: Build the legacy cutover with TDD

**Files:**
- Create: `scripts/dbmate-cutover.mjs`
- Modify: `tests/db/dbmate-tools.test.ts`

- [ ] **Step 1: Write failing cutover plan tests**

Import exact exports:

```js
import {
  LEGACY_VERSION_MAP,
  planLegacyVersionCutover
} from "../../scripts/dbmate-cutover.mjs";
```

Add assertions:

```js
it("maps only present legacy versions and preserves unknown history", () => {
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

it("removes an old alias even when the timestamp version already exists", () => {
  const plan = planLegacyVersionCutover([
    "001_initial_schema",
    "20260101000001"
  ]);
  expect(plan.mappings).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests and verify red state**

Run:

```powershell
npm.cmd run test:run -- tests/db/dbmate-tools.test.ts
```

Expected: FAIL because `scripts/dbmate-cutover.mjs` does not exist.

- [ ] **Step 3: Implement mapping and transactional cutover**

Use this mapping:

```js
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
```

`planLegacyVersionCutover` selects every mapping whose legacy version is present and reports only unrecognized non-14-digit versions as unknown. `cutoverLegacyVersions` must:

```js
const [tables] = await connection.query(`
  SELECT 1
  FROM information_schema.tables
  WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'
`);
if (tables.length === 0) return { mappings: [], unknownLegacyVersions: [] };

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
```

Choose `insertSql` after inspecting whether `applied_at` exists. With it, copy the old timestamp using `INSERT ... SELECT ... ON DUPLICATE KEY UPDATE version = VALUES(version)`; without it, copy only `version`. Always close the connection. The CLI requires `DATABASE_URL`.

- [ ] **Step 4: Run cutover tests green**

Run:

```powershell
npm.cmd run test:run -- tests/db/dbmate-tools.test.ts
```

Expected: all dbmate tool tests pass.

### Task 4: Convert and seal historical migrations

**Files:**
- Rename: `db/migrations/001_initial_schema.sql` through `009_user_version_column.sql`
- Create: `db/migrations/checksums.json`
- Modify: `tests/db/migration-schema.test.ts`

- [ ] **Step 1: Capture original body checksums**

Run a read-only SHA-256 command for all eight current SQL files and retain the values in the test fixture so the wrapped up-section can be compared against the original bytes.

- [ ] **Step 2: Rename migrations**

Run the eight exact `git mv` operations from the design mapping, preserving gaps 007 and the original 008/009 identities.

- [ ] **Step 3: Wrap original bytes with dbmate directives**

For every renamed file, prepend:

```sql
-- migrate:up transaction:false
```

Append:

```sql
-- migrate:down transaction:false
SIGNAL SQLSTATE '45000'
  SET MESSAGE_TEXT = 'Historical migration cannot be rolled back automatically';
```

Do not alter the SQL bytes between the up and down markers.

- [ ] **Step 4: Update schema tests**

Replace legacy filenames with timestamp filenames. Add a test-local helper:

```ts
function migrationUpSql(filename: string) {
  const contents = readFileSync(path.join(process.cwd(), "db", "migrations", filename), "utf8");
  const [, up = ""] = contents.split(/^-- migrate:up[^\n]*\n/m);
  return up.split(/^-- migrate:down[^\n]*$/m)[0];
}
```

Remove the production `splitSqlStatements` import. For the four expected RBAC `ALTER TABLE` statements, use test-local matching against the up SQL. Add assertions for all eight timestamp filenames, both directives, and the captured original body hashes.

- [ ] **Step 5: Seal and verify migrations**

Run:

```powershell
node scripts/dbmate-checksums.mjs seal
node scripts/dbmate-checksums.mjs verify
npx.cmd dbmate --no-dump-schema status
```

Expected: seal and verify pass. Status may require `DATABASE_URL`; file discovery must succeed before any database verification.

### Task 5: Retire the custom runner and preserve read-only history

**Files:**
- Modify: `src/lib/db/migrations.ts`
- Delete: `scripts/db-migrate.mjs`
- Modify: `scripts/db-import-state.mjs`
- Modify: `tests/db/migration-transaction.test.ts`

- [ ] **Step 1: Replace old transaction tests with a failing read-only test**

Test the exact API:

```ts
import { readAppliedMigrationVersions } from "@/lib/db/migrations";

it("reads applied migration history without mutating schema state", async () => {
  const execute = vi.fn(async () => [[
    { version: "20260101000002" },
    { version: "20260101000001" }
  ]]);
  await expect(readAppliedMigrationVersions({ execute } as never))
    .resolves.toEqual(["20260101000001", "20260101000002"]);
  expect(execute).toHaveBeenCalledWith("SELECT version FROM schema_migrations ORDER BY version");
  expect(execute).toHaveBeenCalledTimes(1);
});
```

Run the test and expect failure because the read-only API does not exist.

- [ ] **Step 2: Reduce migrations.ts to read-only helper**

Replace its contents with:

```ts
import type { RowDataPacket } from "mysql2/promise";
import type { DatabaseConnection } from "./connection";

/**
 * @deprecated This module only reads applied migration history.
 * Use dbmate through `npm run db:migrate` for all migration execution.
 */
export async function readAppliedMigrationVersions(connection: DatabaseConnection) {
  const [rows] = await connection.execute<RowDataPacket[]>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );
  return rows.map((row) => String(row.version)).sort();
}
```

- [ ] **Step 3: Remove duplicate executor coupling**

Delete `scripts/db-migrate.mjs`. Remove its import and `await runMigrations({ databaseUrl })` call from `scripts/db-import-state.mjs`. Do not change import transaction behavior.

- [ ] **Step 4: Run targeted tests**

Run:

```powershell
npm.cmd run test:run -- tests/db/migration-transaction.test.ts tests/db/migration-schema.test.ts tests/db/import-state.test.ts tests/db/dbmate-tools.test.ts
```

Expected: all targeted tests pass.

### Task 6: Compose package commands and document operations

**Files:**
- Modify: `package.json`
- Modify: `README.md`

- [ ] **Step 1: Replace migration scripts**

Use these exact command responsibilities:

```json
{
  "db:migrate": "npm run db:migrate:verify && npm run db:migrate:cutover && dbmate --no-dump-schema migrate",
  "db:migrate:new": "dbmate new",
  "db:migrate:rollback": "npm run db:migrate:verify && dbmate --no-dump-schema rollback",
  "db:migrate:status": "dbmate status",
  "db:migrate:seal": "node scripts/dbmate-checksums.mjs seal",
  "db:migrate:verify": "node scripts/dbmate-checksums.mjs verify",
  "db:migrate:cutover": "node scripts/dbmate-cutover.mjs",
  "db:import-state": "npm run db:migrate && node scripts/db-import-state.mjs"
}
```

- [ ] **Step 2: Update README**

Document the eight timestamp filenames, official npm-provided dbmate command, environment-only configuration, first-run cutover, checksum sealing workflow, explicit MariaDB DDL transaction limitation, historical rollback refusal, and new migration example.

- [ ] **Step 3: Verify command surfaces**

Run:

```powershell
npm.cmd run db:migrate:verify
npm.cmd run db:migrate:new -- --help
npm.cmd run db:migrate:status -- --help
```

Expected: checksum verification passes and dbmate help exits 0 without changing files.

### Task 7: Verify against MariaDB and clean temporary state

**Files:**
- Temporary only: `db/migrations/*_test_migration.sql`

- [ ] **Step 1: Snapshot current migration metadata**

Query and record only the `schema_migrations` column definitions and versions. Never print `DATABASE_URL`.

- [ ] **Step 2: Run cutover twice**

Load `DATABASE_URL` from the local environment, run `npm run db:migrate:cutover` twice, then query versions. Expected: the second run maps zero rows; recognized old names are gone; unknown wxauto names remain.

- [ ] **Step 3: Run status and migrations**

Run:

```powershell
npm.cmd run db:migrate:status
npm.cmd run db:migrate
npm.cmd run db:migrate:status
```

Expected: initially missing tracked migrations are pending; afterward all eight are applied.

- [ ] **Step 4: Exercise reversible new migration**

Generate `test_migration`, replace the generated body with:

```sql
-- migrate:up transaction:false
CREATE TABLE dbmate_verification (id INT NOT NULL PRIMARY KEY);

-- migrate:down transaction:false
DROP TABLE dbmate_verification;
```

Run seal, migrate, rollback, delete the temporary file, and seal again. Query `information_schema.tables` to confirm `dbmate_verification` is absent.

- [ ] **Step 5: Confirm clean metadata**

Run status and checksum verification again. Expected: all eight permanent migrations applied, temporary version absent, unknown wxauto history preserved, and no temporary file in git status.

### Task 8: Final verification and single delivery commit

**Files:** all task files

- [ ] **Step 1: Fresh install and targeted verification**

Run:

```powershell
npm.cmd ci
npm.cmd run db:migrate:verify
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/db/migration-transaction.test.ts tests/db/import-state.test.ts tests/db/dbmate-tools.test.ts
```

Expected: clean install and targeted tests pass.

- [ ] **Step 2: Full gates**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
git diff --check
git status --short
```

Expected: at least 742 tests pass, build exits 0, audit does not increase, diff has no whitespace errors, and only intended task files are changed.

- [ ] **Step 3: Create the only commit**

Stage every reviewed task file and commit once using the requested subject and body. The final branch must contain exactly one commit after `main`.

- [ ] **Step 4: Publish and create one PR**

Publish `codex/p1-01-dbmate-migrations`, verify the remote SHA equals local HEAD, and create one PR targeting `main`. Include MariaDB cutover evidence, tests, build, and audit in the PR body. Preserve the worktree for review changes.
