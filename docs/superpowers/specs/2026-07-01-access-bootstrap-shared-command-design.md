# Access Bootstrap Shared Command Design

## Goal

Make `bootstrapAdminInState` the only implementation of administrator bootstrap rules while preserving MariaDB transactionality, row locking, atomic session creation, and the existing repository API.

## Scope

This is PR 1 of the P2-04 migration. It covers:

- `bootstrapAdmin`
- `bootstrapAdminWithSession`
- MariaDB bootstrap snapshot loading and delta persistence
- JSON/MariaDB contract tests for bootstrap behavior

User CRUD, identity binding, login failure/success handling, password changes, and user imports remain unchanged for later PRs.

## Architecture

The repository keeps orchestration and password hashing. The domain service owns all validation and mutation rules. MariaDB becomes a storage adapter for this command:

1. Start one database transaction.
2. Lock the `auth_bootstrap_state` row with `SELECT ... FOR UPDATE`.
3. Load a bootstrap access snapshot containing groups, people, accounts, credentials, roles, role permissions, account-role assignments, sessions, and bootstrap state.
4. Run `bootstrapAdminInState(snapshot, input, passwordHash)`.
5. For the session variant, run `createAccountSessionInState` against the same snapshot.
6. Persist only the snapshot delta and append newly generated audit entries.
7. Commit and return the domain result.

The existing broad `MariaDbStateStore.readState()/writeState()` methods are not used because they do not load or save the complete access-control aggregate and could overwrite unrelated application data.

## Storage Boundary

`mariadb-access-store.ts` will replace its bootstrap business command with storage-only primitives:

- `loadBootstrapAccessState(connection)` loads the command snapshot and acquires the bootstrap lock.
- `saveBootstrapAccessState(connection, before, after)` persists mechanical differences without validating business rules.

The saver handles only data the shared command may change:

- create or enable the selected user group;
- reconcile derived roles and role permissions;
- create or update the bootstrap person and account;
- replace the account's single role assignment and credential;
- revoke sessions invalidated by an existing-account bootstrap;
- update `auth_bootstrap_state`;
- append audit entries created during the command.

It must not delete unrelated people, accounts, credentials, sessions, or audit history.

## Concurrency and Atomicity

The bootstrap row lock remains the serialization point, so two concurrent bootstrap attempts cannot both succeed. Snapshot loading, domain mutation, delta persistence, and optional admin-session creation all run in the same MariaDB transaction. Any validation or SQL failure rolls back the complete operation.

`bootstrapAdminWithSession` uses `createAccountSessionInState`, then persists the new session in the same delta save. No session is created when bootstrap fails.

## Error Behavior

Existing domain errors remain authoritative and identical across JSON and MariaDB:

- bootstrap already completed;
- missing legacy password;
- invalid name or mobile phone;
- missing existing group;
- conflicting account/person data;
- invalid administrator access chain.

Storage failures remain database errors and roll back the transaction. No MariaDB-specific branch may reinterpret a domain validation result.

## Testing

Tests will be written before implementation. The first test must fail on the old MariaDB path specifically because that path bypasses the shared command.

Coverage includes:

- a contract test showing file and MariaDB adapters produce equivalent administrator access semantics for the same existing group/account fixture;
- new-group bootstrap persistence;
- existing-group enablement and admin permission grant;
- duplicate bootstrap rejection with no writes;
- atomic `bootstrapAdminWithSession` persistence;
- existing-account session revocation;
- absence of plaintext passwords in persisted state and audit details;
- existing MariaDB concurrency and rollback tests.

Contract comparisons normalize generated timestamps and identifiers while comparing actor permissions, group capabilities, account linkage, credential flags, bootstrap completion, session semantics, and audit action.

## Operational Constraints

This PR deliberately uses command-scoped access snapshots instead of loading the entire application state. The data volume is bounded to access-control tables, and writes are delta-based. Kysely from P2-01 is therefore optional for this PR and can be adopted later without changing the domain boundary.

## Acceptance Criteria

- `mariadb-access-store.ts` contains no bootstrap validation or administrator construction rules.
- Both storage modes execute `bootstrapAdminInState`.
- Both session variants execute `createAccountSessionInState` atomically.
- Public repository method signatures remain unchanged.
- The focused contract/auth/MariaDB tests pass.
- The full test suite and production build pass.
- `npm audit` vulnerability totals do not increase.
