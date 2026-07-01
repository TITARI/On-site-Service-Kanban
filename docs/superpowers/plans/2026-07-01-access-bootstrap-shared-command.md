# Access Bootstrap Shared Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MariaDB-specific administrator bootstrap rules with the shared `bootstrapAdminInState` command while preserving atomic bootstrap/session persistence.

**Architecture:** `MariaDbStateStore` will orchestrate one transaction: load a command-scoped access snapshot, clone it, run the shared domain command, optionally create the first session in state, then persist only changed access rows. `mariadb-access-store.ts` will expose storage-only load/save primitives and contain no bootstrap validation or actor construction.

**Tech Stack:** TypeScript 6, MariaDB/mysql2, Vitest 4, Node.js 22

---

### Task 1: Establish the baseline and red orchestration contract

**Files:**
- Create: `tests/db/access-bootstrap-contract.test.ts`
- Reference: `tests/db/mariadb-state-store.test.ts`
- Reference: `tests/repositories/access-file-repository.test.ts`

- [ ] **Step 1: Install the isolated worktree dependencies and capture the baseline**

Run:

```powershell
npm.cmd ci
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
```

Expected: the existing full suite and build pass; audit reports the same three baseline vulnerabilities present on `origin/main`.

- [ ] **Step 2: Add a contract fixture with stable account identifiers**

Create a fixture in `tests/db/access-bootstrap-contract.test.ts` whose access state contains:

```ts
const initial = {
  booths: [],
  tickets: [],
  messageRecords: [],
  people: [{
    id: "person-admin",
    name: "Pending Admin",
    phone: "13700137000",
    role: "reporter",
    groupId: "admin",
    groupName: "Administrators",
    groupLocked: false,
    enabled: true,
    version: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  }],
  accounts: [{
    id: "account-person-admin",
    personId: "person-admin",
    loginName: "13700137000",
    enabled: true,
    authVersion: 1,
    version: 0,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z"
  }],
  accountCredentials: [],
  roles: [],
  accountRoles: [],
  rolePermissions: [],
  accountSessions: [],
  auditLogs: [],
  authBootstrap: {},
  chatIdentities: [],
  config: {
    ...defaultConfig(),
    userGroups: [{
      id: "admin",
      name: "Administrators",
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: false,
      enabled: false
    }]
  }
} satisfies AppState;
```

Mock `loadBootstrapAccessState` to return a clone of this state, capture the arguments passed to `saveBootstrapAccessState`, and wrap the real `bootstrapAdminInState` in a Vitest spy.

- [ ] **Step 3: Write the failing MariaDB/shared-command contract**

Call `new MariaDbStateStore().bootstrapAdmin(...)` and assert:

```ts
expect(accessServiceMocks.bootstrapAdminInState).toHaveBeenCalledOnce();
expect(accessStoreMocks.saveBootstrapAccessState).toHaveBeenCalledOnce();
expect(savedAfter).toMatchObject({
  authBootstrap: { completedByAccountId: "account-person-admin" },
  people: [expect.objectContaining({
    id: "person-admin",
    role: "admin",
    groupLocked: true
  })],
  accounts: [expect.objectContaining({
    id: "account-person-admin",
    authVersion: 2
  })]
});
expect(savedAfter.config.userGroups).toContainEqual(
  expect.objectContaining({ id: "admin", canAdmin: true, enabled: true })
);
expect(savedAfter.auditLogs).toContainEqual(
  expect.objectContaining({ action: "admin.bootstrap" })
);
```

- [ ] **Step 4: Run the new test and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/db/access-bootstrap-contract.test.ts
```

Expected: FAIL because the current MariaDB path calls `mariadb-access-store.bootstrapAdmin` and never invokes `bootstrapAdminInState` or `saveBootstrapAccessState`.

### Task 2: Specify the MariaDB snapshot storage primitives

**Files:**
- Modify: `tests/db/mariadb-access-store.test.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`

- [ ] **Step 1: Write a failing loader test**

Import `loadBootstrapAccessState`. Configure `recordingConnection` to return rows for these exact queries:

```text
SELECT ... FROM auth_bootstrap_state ... FOR UPDATE
SELECT ... FROM user_groups ORDER BY id
SELECT * FROM people ORDER BY created_at
SELECT * FROM accounts ORDER BY created_at
SELECT * FROM account_credentials ORDER BY account_id
SELECT * FROM roles ORDER BY id
SELECT * FROM account_roles ORDER BY account_id
SELECT * FROM role_permissions ORDER BY role_id, permission_code
SELECT * FROM account_sessions ORDER BY created_at
```

Call:

```ts
const state = await loadBootstrapAccessState(connection, {
  ...defaultConfig(),
  userGroups: []
});
```

Assert the bootstrap query contains `FOR UPDATE`, snake_case rows are mapped to domain fields, and `state.config.userGroups` comes from `user_groups` rather than the supplied config.

- [ ] **Step 2: Write a failing delta-saver test**

Create `before` and `after` snapshots where only one group, person, account, credential, assignment, session, bootstrap state, and audit entry changed. Call:

```ts
await saveBootstrapAccessState(connection, before, after);
```

Assert the recorded SQL contains:

```text
INSERT INTO user_groups ... ON DUPLICATE KEY UPDATE
INSERT INTO roles ... ON DUPLICATE KEY UPDATE
DELETE FROM role_permissions WHERE role_id = ?
INSERT INTO role_permissions
INSERT INTO people ... ON DUPLICATE KEY UPDATE
INSERT INTO accounts ... ON DUPLICATE KEY UPDATE
INSERT INTO account_credentials ... ON DUPLICATE KEY UPDATE
DELETE FROM account_roles WHERE account_id = ?
INSERT INTO account_roles
INSERT INTO account_sessions ... ON DUPLICATE KEY UPDATE
INSERT INTO auth_bootstrap_state ... ON DUPLICATE KEY UPDATE
INSERT INTO audit_logs
```

Also assert no `DELETE FROM people`, `DELETE FROM accounts`, `DELETE FROM account_credentials`, `DELETE FROM account_sessions`, or blanket `DELETE FROM audit_logs` statement is issued.

- [ ] **Step 3: Run the storage tests and verify RED**

Run:

```powershell
npm.cmd run test:run -- tests/db/mariadb-access-store.test.ts
```

Expected: FAIL because `loadBootstrapAccessState` and `saveBootstrapAccessState` do not exist.

- [ ] **Step 4: Implement `loadBootstrapAccessState`**

Add domain imports for `AppState`, `Account`, `Role`, `AccountRole`, `RolePermission`, `AccessAuditLogEntry`, and `AuthBootstrapState`. Export:

```ts
export async function loadBootstrapAccessState(
  connection: DatabaseConnection,
  config: AppConfig
): Promise<AppState>
```

The function must first lock `auth_bootstrap_state`, then read the eight access tables. Map database dates with `requiredIso`/`iso`, booleans with `bool`, numeric versions with `Number`, and return empty non-access collections. Build the config as:

```ts
config: {
  ...config,
  userGroups: await readGroups(connection)
}
```

Set `auditLogs: []`; bootstrap only appends a new audit and does not inspect history.

- [ ] **Step 5: Implement `saveBootstrapAccessState` as mechanical delta persistence**

Export:

```ts
export async function saveBootstrapAccessState(
  connection: DatabaseConnection,
  before: AppState,
  after: AppState
): Promise<void>
```

Use maps keyed by each entity's stable key and compare serialized domain values. Persist only added or changed entities. Reconcile role permissions per changed role and account-role assignments per changed account. Upsert sessions so the same primitive handles both newly created sessions and revocations. Append only audit IDs absent from `before.auditLogs`.

Use database timestamps parsed from each domain object's ISO strings; do not replace domain timestamps with the persistence time.

- [ ] **Step 6: Run storage tests and verify GREEN**

Run:

```powershell
npm.cmd run test:run -- tests/db/mariadb-access-store.test.ts
```

Expected: PASS.

### Task 3: Replace MariaDB bootstrap orchestration with the shared command

**Files:**
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Test: `tests/db/access-bootstrap-contract.test.ts`
- Test: `tests/db/mariadb-state-store.test.ts`

- [ ] **Step 1: Import the shared commands and storage primitives**

In `mariadb-state-store.ts`, import:

```ts
import {
  bootstrapAdminInState,
  createAccountSessionInState
} from "../services/access-state-service";
import {
  loadBootstrapAccessState,
  saveBootstrapAccessState
} from "./mariadb-access-store";
```

Remove the `bootstrapAdmin as bootstrapAdminAccess` import.

- [ ] **Step 2: Replace `bootstrapAdmin`**

Use exactly one transaction and one shared domain mutation:

```ts
async bootstrapAdmin(input: BootstrapAdminInput) {
  const passwordHash = await hashPassword(input.password);
  return await withDatabaseTransaction(async (connection) => {
    const before = await loadBootstrapAccessState(
      connection,
      await latestConfig(connection)
    );
    const after = structuredClone(before);
    const actor = bootstrapAdminInState(after, input, passwordHash);
    await saveBootstrapAccessState(connection, before, after);
    await writeConfigVersion(
      connection,
      after.config,
      new Date(),
      actor,
      "Administrator bootstrap"
    );
    return actor;
  });
}
```

Remove the MariaDB-only legacy-password precheck so the shared command is authoritative. The file repository must remove the same duplicate precheck before calling `bootstrapAdminInState`.

- [ ] **Step 3: Replace `bootstrapAdminWithSession`**

Within one transaction, load and clone the snapshot, run `bootstrapAdminInState`, then run:

```ts
const session = createAccountSessionInState(
  after,
  actor.accountId,
  "admin",
  tokenHash,
  expiresAt
);
```

Persist the delta once, write the config version once, and return `{ actor, session }`. Do not call the direct SQL `createAccountSession` command.

- [ ] **Step 4: Delete the obsolete SQL bootstrap command**

Remove `createdAdminGroupId` and the exported `bootstrapAdmin` implementation from `mariadb-access-store.ts`. Remove `BootstrapAdminInput` if it is no longer used in that file. Retain `createHash` because identity ID generation still uses it.

- [ ] **Step 5: Update existing MariaDB bootstrap tests**

Change the responders in `tests/db/mariadb-state-store.test.ts` to provide the snapshot loader's table rows. Preserve assertions that:

- `app_config_versions` receives the updated admin group;
- `bootstrapAdminWithSession` inserts the session in the same transaction;
- a transaction-helper failure performs no SQL;
- plaintext legacy and administrator passwords never appear in recorded SQL parameters or audit JSON.

- [ ] **Step 6: Run contract and focused authentication tests**

Run:

```powershell
npm.cmd run test:run -- tests/db/access-bootstrap-contract.test.ts
npm.cmd run test:run -- tests/db/mariadb-access-store.test.ts
npm.cmd run test:run -- tests/db/mariadb-state-store.test.ts
npm.cmd run test:run -- tests/repositories/access-file-repository.test.ts
npm.cmd run test:run -- tests/services/auth-service.test.ts
npm.cmd run test:run -- tests/api/admin-auth-routes.test.ts
```

Expected: all focused suites pass.

### Task 4: Verify atomicity and parity edge cases

**Files:**
- Modify: `tests/db/access-bootstrap-contract.test.ts`
- Modify: `tests/db/mariadb-access-store.test.ts`

- [ ] **Step 1: Add the session contract**

Call `bootstrapAdminWithSession` with a lowercase 64-character token hash and a future expiry. Assert the captured `after` snapshot contains exactly one admin session whose `accountId` and `authVersion` match the bootstrapped account. Assert `saveBootstrapAccessState` is called once.

- [ ] **Step 2: Add duplicate-bootstrap and rollback contracts**

Return a snapshot with `authBootstrap.completedAt` set and assert the shared domain error matches `/bootstrap.*completed/i`. Assert `saveBootstrapAccessState` is not called. Make the saver reject and assert the transaction promise rejects without returning an actor or session.

- [ ] **Step 3: Add existing-account session revocation coverage**

Seed one active session for `account-person-admin`, bootstrap the existing account, and assert the saved snapshot has an increased account `authVersion` and a `revokedAt` value on the old session.

- [ ] **Step 4: Run the focused suites**

Run:

```powershell
npm.cmd run test:run -- tests/db/access-bootstrap-contract.test.ts tests/db/mariadb-access-store.test.ts tests/db/mariadb-state-store.test.ts tests/repositories/access-file-repository.test.ts tests/services/auth-service.test.ts tests/api/admin-auth-routes.test.ts
```

Expected: PASS with zero failed tests.

### Task 5: Full verification and one-commit PR

**Files:**
- Include: `docs/superpowers/specs/2026-07-01-access-bootstrap-shared-command-design.md`
- Include: `docs/superpowers/plans/2026-07-01-access-bootstrap-shared-command.md`
- Include all implementation and test files from Tasks 1-4

- [ ] **Step 1: Run final verification**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
npm.cmd ci --dry-run
git diff --check
```

Expected: the full suite and build pass, audit totals do not exceed baseline, the lockfile is valid, and the diff has no whitespace errors.

- [ ] **Step 2: Review the task boundary**

Run:

```powershell
git diff --stat
git diff -- src/lib/services/access-state-service.ts src/lib/db/mariadb-access-store.ts src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts
```

Confirm no user CRUD, identity-binding, login-record, password-change, or user-import command has been migrated in this PR.

- [ ] **Step 3: Create the single required commit**

Run:

```powershell
git add docs/superpowers/specs/2026-07-01-access-bootstrap-shared-command-design.md docs/superpowers/plans/2026-07-01-access-bootstrap-shared-command.md src/lib/db/mariadb-access-store.ts src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts tests/db/access-bootstrap-contract.test.ts tests/db/mariadb-access-store.test.ts tests/db/mariadb-state-store.test.ts tests/repositories/access-file-repository.test.ts
git commit -m "refactor(access): 提取 bootstrapAdmin 为共享领域命令"
```

Expected: one commit containing only P2-04 PR 1.

- [ ] **Step 4: Push and create the PR**

Push `codex/p2-04-bootstrap-shared-command` and create a ready PR targeting `main`. Include test/build/audit evidence and note that PRs 2-4 remain out of scope.
