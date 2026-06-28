# Dbmate Migration Replacement Design

**Date:** 2026-06-28
**Status:** Approved
**Task:** P1-01

## Goal

Replace the duplicated SQL parsing and migration execution code with dbmate while preserving the current MariaDB schema history, adding deterministic migration-file integrity checks, and keeping database import workflows operational.

## Constraints and corrected assumptions

- Deliver the task as one final commit and one pull request.
- Install the official `dbmate@2.33.0` npm development dependency. This is cross-platform and is installed automatically by `npm ci`.
- Dbmate has no `.dbmate` configuration file. Commands use environment variables and explicit CLI flags.
- Dbmate stores migration versions but not migration contents or checksums. A small SHA-256 manifest verifier supplies the required tamper detection without parsing or executing SQL.
- MariaDB DDL is not made atomic by a transaction wrapper. Historical migrations use `transaction:false` so the behavior is explicit rather than falsely transactional.
- Existing SQL statements remain byte-for-byte unchanged. Only dbmate directive comments are added around them.
- The repository has no CI workflow to edit. Installing dbmate as a development dependency makes it available to any CI job that runs `npm ci`.

## Architecture

### Dbmate command layer

`package.json` exposes these commands:

- `db:migrate`: verify checksums, run the idempotent legacy-version cutover, then run `dbmate --no-dump-schema migrate`. The pinned 2.33.0 binary does not expose the `--strict` option advertised on the repository's moving main branch, so ordering is enforced through immutable timestamp names and manifest coverage.
- `db:migrate:new`: run `dbmate new`.
- `db:migrate:rollback`: verify checksums, then run `dbmate --no-dump-schema rollback`.
- `db:migrate:status`: run `dbmate status` without mutating the database.
- `db:migrate:seal`: regenerate the SHA-256 manifest after a migration is created and finalized.
- `db:migrate:verify`: verify migration names, coverage, and SHA-256 values without connecting to a database.
- `db:migrate:cutover`: run the legacy metadata conversion explicitly; `db:migrate` invokes the same operation automatically.
- `db:import-state`: run `db:migrate` before the existing import script.

The command layer passes failures through unchanged. A failed checksum verification prevents all database access. A failed cutover prevents dbmate from running. A failed migration prevents state import.

### Migration file conversion

The eight tracked migrations are renamed without changing their numeric identity:

| Legacy file | Dbmate file | Dbmate version |
| --- | --- | --- |
| `001_initial_schema.sql` | `20260101000001_initial_schema.sql` | `20260101000001` |
| `002_keyword_rule_sets.sql` | `20260101000002_keyword_rule_sets.sql` | `20260101000002` |
| `003_user_rbac_management.sql` | `20260101000003_user_rbac_management.sql` | `20260101000003` |
| `004_exhibitor_booth_identity.sql` | `20260101000004_exhibitor_booth_identity.sql` | `20260101000004` |
| `005_ticket_optimistic_lock.sql` | `20260101000005_ticket_optimistic_lock.sql` | `20260101000005` |
| `006_bootstrap_rate_limits.sql` | `20260101000006_bootstrap_rate_limits.sql` | `20260101000006` |
| `008_session_kind.sql` | `20260101000008_session_kind.sql` | `20260101000008` |
| `009_user_version_column.sql` | `20260101000009_user_version_column.sql` | `20260101000009` |

Each historical file receives `-- migrate:up transaction:false` before the original SQL and a `-- migrate:down transaction:false` section that raises a clear MariaDB error. Historical rollback must fail safely instead of deleting the version record while leaving implicitly committed DDL in place. New migrations use dbmate's generated up/down template and must choose `transaction:false` when they contain MariaDB DDL.

### Legacy history cutover

`scripts/dbmate-cutover.mjs` performs metadata-only DML using `mysql2`:

1. Require `DATABASE_URL` and connect to MariaDB.
2. Detect whether `schema_migrations` exists. If it does not, exit successfully and let dbmate create it.
3. Inspect whether the legacy `applied_at` column exists.
4. In one transaction, map only old versions that are present to their timestamp versions.
5. Preserve the original `applied_at` value when the column exists.
6. Delete the mapped legacy row after the timestamp row exists.
7. Leave unrecognized history such as `003_wxauto_mcp` and `004_wxauto_state_lock` unchanged.

The operation is idempotent. If both old and new versions exist, the timestamp version wins and the old row is removed. Missing tracked versions remain pending and are applied by dbmate.

The existing table is compatible: `version varchar(64)` can store all 14-digit versions, and the extra `applied_at` column has a default value for dbmate inserts.

### Checksum guard

`scripts/dbmate-checksums.mjs` owns two operations:

- `verify`: require every tracked migration to appear exactly once in `db/migrations/checksums.json`, reject untracked manifest entries, validate SHA-256 values, validate timestamp filenames, and require both dbmate directives.
- `seal`: deterministically rewrite the manifest for every tracked SQL migration after the developer finishes editing a new migration.

The verifier normalizes Git CRLF checkouts to LF and then hashes UTF-8 bytes. It does not split, interpret, or execute SQL. The manifest is committed with migration changes. Any later substantive edit to a sealed historical migration fails before database access.

### Deprecated TypeScript module

`src/lib/db/migrations.ts` no longer exports a SQL splitter or migration runner. It is retained as a deprecated, read-only history helper that can query applied versions for diagnostics. The module-level deprecation comment directs all new migration work to the npm dbmate commands.

`scripts/db-migrate.mjs` is deleted. `scripts/db-import-state.mjs` no longer imports it; migration ordering is enforced by the package command composition.

## Error handling

- Missing `DATABASE_URL` produces a concise failure before cutover or dbmate migration.
- Checksum mismatch, missing manifest coverage, invalid filenames, or missing directives exits nonzero before connecting to MariaDB.
- Cutover rolls back all metadata changes on any error.
- Unknown legacy versions are preserved and reported, not deleted.
- Historical rollback raises an intentional database error and retains the applied version.
- Dbmate exit codes and diagnostic output are propagated to callers.

## Testing

### Automated tests

- Replace custom runner transaction tests with tests for checksum verification, migration format, cutover planning, and deprecated read-only history behavior.
- Update schema tests to use the timestamp filenames and inspect only the `migrate:up` section.
- Test that every original SQL body is preserved between the dbmate directives.
- Test that checksum tampering, missing coverage, duplicate versions, and malformed migration names fail.
- Test cutover behavior for old-only, new-only, both-present, missing, and unknown legacy versions.
- Keep the complete existing test suite passing.

### MariaDB integration verification

Against the configured local MariaDB database:

1. Run the cutover twice and verify identical final history.
2. Run `dbmate status` and confirm mapped migrations are applied while genuinely missing migrations remain pending.
3. Run `npm run db:migrate` and confirm all tracked migrations are applied.
4. Create a temporary migration with `db:migrate:new`, add reversible up/down SQL, seal it, migrate it, and roll it back.
5. Remove the temporary migration and reseal without leaving database or worktree residue.

### Delivery gates

- Targeted migration and import-state tests pass.
- `npm run test:run` passes at or above the 742-test baseline.
- `npm run build` succeeds.
- `npm audit` does not increase from the task baseline.
- The final diff contains one commit using the requested commit message and one pull request.

## Documentation

README migration commands and filenames are updated. The first deployment procedure explicitly runs the idempotent cutover before checking status. Dbmate behavior is documented against the official project: <https://github.com/amacneil/dbmate>.
