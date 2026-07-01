# Argon2id Transparent Rehash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate Argon2id hashes for all new passwords while transparently and safely replacing legacy scrypt hashes after successful administrator authentication.

**Architecture:** Preserve the strict legacy scrypt verifier and route new PHC hashes to `@node-rs/argon2`. Add a hash-only compare-and-swap repository method for file and MariaDB storage; the auth service awaits this best-effort upgrade after successful verification without letting upgrade failures block session creation.

**Tech Stack:** Next.js 16, TypeScript 6, Node crypto, `@node-rs/argon2@2.0.2`, Vitest 4, JSON state repository, MariaDB.

---

## Workflow constraints

- Base: `origin/main` at `c094e38275ff7486b4e75dad60407d01ddd8a2f6` or newer.
- Worktree: `.worktrees/p1-05-argon2id` on `codex/p1-05-argon2id`.
- One task = one commit = one PR; design, plan, dependency, implementation, and tests share the final commit.
- Baseline: 94 files / 767 tests, successful build, 3 audit findings (2 moderate, 1 high).
- Never log passwords or encoded hashes.

## Task 1: Password service RED

**Files:**

- Modify: `tests/services/password-service.test.ts`
- Modify: `tests/services/user-admin-service.test.ts`

- [ ] Replace the scrypt-generation assertions with an Argon2id PHC assertion for `m=19456,t=2,p=1` and fresh salts.
- [ ] Add a deterministic real legacy scrypt helper using Node crypto and prove correct/wrong legacy passwords.
- [ ] Add `needsRehash` assertions: legacy scrypt true, current Argon2id false, unknown false.
- [ ] Preserve short/oversized password, malformed input, and operational legacy scrypt failure coverage.
- [ ] Update user-admin password persistence expectation from `^scrypt\$` to `^\$argon2id\$`.
- [ ] Run `npm.cmd run test:run -- tests/services/password-service.test.ts tests/services/user-admin-service.test.ts` and verify failure is caused by missing Argon2 behavior/API.

## Task 2: Argon2 password service GREEN

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/lib/services/password-service.ts`

- [ ] Install exact `@node-rs/argon2@2.0.2`.
- [ ] Inspect installed TypeScript declarations and use the library's actual exported `Algorithm`, `hash`, and `verify` API.
- [ ] Keep `PASSWORD_MIN_LENGTH=10` and 1024 UTF-8 byte limit.
- [ ] Move current strict scrypt verification helpers behind a private `verifyLegacyScrypt` function.
- [ ] Generate new hashes with Argon2id `memoryCost=19456`, `timeCost=2`, `parallelism=1`.
- [ ] Route only `$argon2id$` and `scrypt$` prefixes; reject unknown formats without expensive work.
- [ ] Export `needsRehash` for canonical legacy scrypt hashes.
- [ ] Run focused password/user-admin tests until GREEN.

## Task 3: Repository CAS RED/GREEN

**Files:**

- Modify: `tests/repositories/app-repository.test.ts`
- Modify: `tests/repositories/access-file-repository.test.ts`
- Modify: `tests/db/mariadb-access-store.test.ts`
- Modify: `src/lib/services/access-state-service.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`

- [ ] Add failing repository contract/proxy assertions for `upgradeAdminPasswordHash(accountId, expectedHash, replacementHash)`.
- [ ] Add failing file-state tests proving CAS success, mismatch false, and no changes to password metadata/audit.
- [ ] Add failing MariaDB tests asserting the conditional `UPDATE`, parameter order, affectedRows result, and absence of audit writes.
- [ ] Add `upgradeAdminPasswordHashInState` with hash-only atomic mutation.
- [ ] Add the method to `AppRepository`, file repository, MariaDB repository proxy, and `MariaDbStateStore`.
- [ ] Add MariaDB access SQL implementation returning boolean.
- [ ] Run the three focused repository/store test files until GREEN.

## Task 4: Auth transparent upgrade RED/GREEN

**Files:**

- Modify: `tests/services/auth-service.test.ts`
- Modify: `tests/api/admin-auth-routes.test.ts`
- Modify: `src/lib/services/auth-service.ts`

- [ ] Add a service test where a real legacy scrypt credential logs in, CAS receives a new `$argon2id$` hash, and a session is created.
- [ ] Add tests proving current Argon2id and wrong passwords do not call CAS.
- [ ] Add a test where CAS rejects; spy on `console.warn` and prove login/session still succeeds without secret data in the log call.
- [ ] Add the repository method to the API route mock and retain existing route login coverage.
- [ ] Import `hashPassword`, `verifyPassword`, and `needsRehash` in auth service.
- [ ] After `recordAdminLoginSuccess`, run the best-effort rehash helper, log info only on true, warn on thrown error, then create the session.
- [ ] Run auth service and admin-auth route tests until GREEN.

## Task 5: Cross-feature verification and delivery

**Files:** Review every modified file above.

- [ ] Run focused tests:

```powershell
npm.cmd run test:run -- tests/services/password-service.test.ts tests/services/auth-service.test.ts tests/services/user-admin-service.test.ts tests/api/admin-auth-routes.test.ts tests/repositories/app-repository.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
```

- [ ] Scan for obsolete generation expectations and secret logging:

```powershell
rg -n "expect.*scrypt|console\.(info|warn).*Hash|console\.(info|warn).*password" tests src
```

- [ ] Run fresh release gates:

```powershell
npm.cmd run test:run
npm.cmd run build
npm.cmd audit --json
git diff --check
```

- [ ] Confirm at least 94 files / 767 tests pass, build succeeds, audit remains at or below 3, and diff check is clean.
- [ ] Stage only P1-05 files and review the staged patch.
- [ ] Commit once with the user-provided message exactly.
- [ ] Push `codex/p1-05-argon2id` and create one ready PR targeting `main` with OWASP reference, CAS semantics, test/build/audit evidence, and native-binary platform note.
