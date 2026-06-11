# User RBAC Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build server-backed RBAC authentication and an admin user-management center with user CRUD, group-inherited permissions, WeChat/WeCom binding, and conflict-aware bulk import.

**Architecture:** Keep `AppRepository` as the storage-agnostic application boundary, extend it with focused access-control operations, and implement those operations for both MariaDB and JSON storage. Authentication, password hashing, permission checks, user administration, identity binding, and import parsing live in separate service/domain modules; existing routes and UI consume those services instead of trusting browser-local identity.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, MariaDB/mysql2, Node `crypto` (`scrypt`, SHA-256, random tokens), XLSX, Vitest, Testing Library.

---

## Scope And Delivery Order

The specification spans four dependent subsystems. Execute them in this order so every checkpoint leaves a testable application:

1. RBAC schema, types, repository support, and session primitives.
2. Mobile/admin authentication and group permission synchronization.
3. Admin user CRUD, password management, and chat identity binding.
4. Bulk import, ticket-route enforcement, rollout cleanup, and full verification.

Do not begin the next phase while the previous phase's targeted tests are failing.

## File Structure

### New Domain And Service Files

- `src/lib/domain/access-control.ts`: RBAC, account, session, admin user, and import types plus fixed permission constants.
- `src/lib/services/password-service.ts`: `scrypt` password hash and verification.
- `src/lib/services/session-service.ts`: session token creation, cookie parsing, cookie serialization, and request actor guards.
- `src/lib/services/auth-service.ts`: mobile login, admin login, logout, first-admin bootstrap, and session resolution.
- `src/lib/services/user-admin-service.ts`: user validation, last-admin protection, deletion eligibility, CRUD, password reset, and audit details.
- `src/lib/services/chat-identity-admin-service.ts`: bind, unbind, conflict token creation, and confirmed rebind.
- `src/lib/domain/user-import.ts`: row normalization, validation, conflict categories, and import decisions.
- `src/lib/services/user-import-service.ts`: preview creation, decision updates, stale-check validation, commit, and report rows.
- `src/lib/db/mariadb-access-store.ts`: focused MariaDB queries and transactional access-control operations.

### New API Routes

- `src/app/api/auth/mobile/login/route.ts`
- `src/app/api/auth/mobile/logout/route.ts`
- `src/app/api/auth/session/route.ts`
- `src/app/api/admin/auth/login/route.ts`
- `src/app/api/admin/auth/logout/route.ts`
- `src/app/api/admin/auth/bootstrap/route.ts`
- `src/app/api/admin/users/route.ts`
- `src/app/api/admin/users/[userId]/route.ts`
- `src/app/api/admin/users/[userId]/disable/route.ts`
- `src/app/api/admin/users/[userId]/enable/route.ts`
- `src/app/api/admin/users/[userId]/password/route.ts`
- `src/app/api/admin/chat-identities/route.ts`
- `src/app/api/admin/users/[userId]/chat-identities/[platform]/route.ts`
- `src/app/api/admin/user-imports/preview/route.ts`
- `src/app/api/admin/user-imports/[jobId]/rows/route.ts`
- `src/app/api/admin/user-imports/[jobId]/commit/route.ts`
- `src/app/api/admin/user-imports/[jobId]/route.ts`
- `src/app/api/admin/user-imports/[jobId]/report/route.ts`

### New UI Files

- `src/app/admin/users/page.tsx`: users route entry.
- `src/components/admin-users-panel.tsx`: filters, table, editor, status actions, password reset, and identity controls.
- `src/components/admin-user-import.tsx`: three-step import workflow.
- `src/lib/client/session-auth.ts`: mobile/admin session API helpers; no authorization state in local storage.

### Existing Files With Focused Changes

- `db/migrations/003_user_rbac_management.sql`: schema and seed migration.
- `src/lib/domain/types.ts`: add `canAdmin`, `groupId`, and `groupLocked`.
- `src/lib/domain/app-state.ts`, `src/lib/storage/file-store.ts`: JSON access-control state and atomic updates.
- `src/lib/repositories/app-repository.ts`: new repository contracts and both storage implementations.
- `src/lib/db/mariadb-state-store.ts`: delegate access operations and synchronize config/RBAC transactionally.
- `src/lib/seed.ts`, `src/lib/services/config-service.ts`: admin permission normalization and validation.
- `src/components/admin-shell.tsx`, `src/components/admin-panel.tsx`, `src/styles/globals.css`: server session login and user-management navigation.
- `src/app/page.tsx`, `src/components/login-panel.tsx`, `src/lib/client/auth.ts`: server mobile session.
- Ticket API routes and ticket components: derive actors and permissions from sessions.

---

## Phase 1: RBAC Foundation

### Task 1: Add The RBAC Migration And Domain Types

**Files:**
- Create: `db/migrations/003_user_rbac_management.sql`
- Create: `src/lib/domain/access-control.ts`
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/domain/app-state.ts`
- Modify: `src/lib/storage/file-store.ts`
- Modify: `src/lib/seed.ts`
- Test: `tests/db/migration-schema.test.ts`
- Test: `tests/domain/access-control.test.ts`
- Test: `tests/services/file-store.test.ts`

- [ ] **Step 1: Write failing schema and domain tests**

Add assertions that the migration contains all RBAC tables, import-preview columns, the one-person-per-platform identity constraint, and four permission seeds:

```ts
const accessSchema = readFileSync(
  path.join(process.cwd(), "db", "migrations", "003_user_rbac_management.sql"),
  "utf-8"
);

it("adds account, RBAC, credential, and session tables", () => {
  ["accounts", "account_credentials", "roles", "account_roles", "permissions", "role_permissions", "account_sessions", "auth_bootstrap_state"]
    .forEach((table) => expect(accessSchema).toContain(`CREATE TABLE IF NOT EXISTS ${table}`));
  expect(accessSchema).toContain("uniq_chat_identity_person_platform");
  expect(accessSchema).toContain("'ticket.claim'");
  expect(accessSchema).toContain("'ticket.process'");
  expect(accessSchema).toContain("'ticket.accept'");
  expect(accessSchema).toContain("'admin.access'");
});
```

Create `tests/domain/access-control.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { permissionCodesForGroup } from "@/lib/domain/access-control";

describe("permissionCodesForGroup", () => {
  it("maps fixed group flags to stable permission codes", () => {
    expect(permissionCodesForGroup({
      id: "ops",
      name: "运营组",
      description: "",
      canClaim: true,
      canProcess: false,
      canAccept: true,
      canAdmin: true,
      enabled: true
    })).toEqual(["ticket.claim", "ticket.accept", "admin.access"]);
  });
});
```

- [ ] **Step 2: Run tests and verify the new expectations fail**

Run:

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/domain/access-control.test.ts tests/services/file-store.test.ts
```

Expected: FAIL because migration `003_user_rbac_management.sql`, access-control types, and new state defaults do not exist.

- [ ] **Step 3: Add the migration**

Create tables and columns with these exact relationships:

```sql
ALTER TABLE people
  ADD COLUMN group_locked boolean NOT NULL DEFAULT false AFTER group_name_snapshot;

CREATE TABLE IF NOT EXISTS accounts (
  id varchar(128) NOT NULL PRIMARY KEY,
  person_id varchar(64) NOT NULL,
  login_name varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  auth_version int NOT NULL DEFAULT 1,
  last_login_at datetime(3) NULL,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_accounts_person (person_id),
  UNIQUE KEY uniq_accounts_login_name (login_name),
  KEY idx_accounts_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_credentials (
  account_id varchar(128) NOT NULL PRIMARY KEY,
  password_hash varchar(255) NOT NULL,
  password_changed_at datetime(3) NOT NULL,
  must_change_password boolean NOT NULL DEFAULT false,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until datetime(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS roles (
  id varchar(128) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL,
  source_group_id varchar(64) NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at datetime(3) NOT NULL,
  updated_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_roles_source_group (source_group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  code varchar(64) NOT NULL PRIMARY KEY,
  name varchar(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_roles (
  account_id varchar(128) NOT NULL,
  role_id varchar(128) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY (account_id, role_id),
  UNIQUE KEY uniq_account_single_role (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id varchar(128) NOT NULL,
  permission_code varchar(64) NOT NULL,
  created_at datetime(3) NOT NULL,
  PRIMARY KEY (role_id, permission_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_sessions (
  id varchar(64) NOT NULL PRIMARY KEY,
  account_id varchar(128) NOT NULL,
  session_type varchar(16) NOT NULL,
  token_hash char(64) NOT NULL,
  auth_version int NOT NULL,
  expires_at datetime(3) NOT NULL,
  last_seen_at datetime(3) NOT NULL,
  revoked_at datetime(3) NULL,
  created_at datetime(3) NOT NULL,
  UNIQUE KEY uniq_account_session_token (token_hash),
  KEY idx_account_sessions_lookup (token_hash, session_type, revoked_at, expires_at),
  KEY idx_account_sessions_account (account_id, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_bootstrap_state (
  id varchar(32) NOT NULL PRIMARY KEY,
  completed_at datetime(3) NULL,
  completed_by_account_id varchar(128) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO permissions (code, name) VALUES
  ('ticket.claim', '认领工单'),
  ('ticket.process', '处理工单'),
  ('ticket.accept', '验收工单'),
  ('admin.access', '后台管理');

UPDATE people p
JOIN user_groups g ON p.group_id IS NULL AND p.group_name_snapshot = g.name
SET p.group_id = g.id;

UPDATE people
SET group_id = (
  SELECT fallback_group.id
  FROM user_groups fallback_group
  WHERE fallback_group.enabled = true
  ORDER BY fallback_group.created_at, fallback_group.id
  LIMIT 1
)
WHERE group_id IS NULL;

INSERT IGNORE INTO roles (id, name, source_group_id, enabled, created_at, updated_at)
SELECT CONCAT('role-', id), name, id, enabled, created_at, updated_at
FROM user_groups;

INSERT IGNORE INTO role_permissions (role_id, permission_code, created_at)
SELECT CONCAT('role-', id), 'ticket.claim', updated_at FROM user_groups WHERE can_claim = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.process', updated_at FROM user_groups WHERE can_process = true
UNION ALL
SELECT CONCAT('role-', id), 'ticket.accept', updated_at FROM user_groups WHERE can_accept = true
UNION ALL
SELECT CONCAT('role-', id), 'admin.access', updated_at FROM user_groups WHERE can_admin = true;

INSERT IGNORE INTO accounts (
  id, person_id, login_name, enabled, auth_version, last_login_at, created_at, updated_at
)
SELECT CONCAT('account-', id), id, phone, enabled, 1, NULL, created_at, updated_at
FROM people;

INSERT IGNORE INTO account_roles (account_id, role_id, created_at)
SELECT CONCAT('account-', p.id), CONCAT('role-', p.group_id), p.updated_at
FROM people p
WHERE p.group_id IS NOT NULL;

INSERT IGNORE INTO auth_bootstrap_state (id, completed_at, completed_by_account_id)
VALUES ('admin', NULL, NULL);

UPDATE chat_identities duplicate_identity
JOIN chat_identities keeper
  ON duplicate_identity.person_id = keeper.person_id
 AND duplicate_identity.platform = keeper.platform
 AND duplicate_identity.id > keeper.id
SET duplicate_identity.person_id = NULL,
    duplicate_identity.verified_by = NULL,
    duplicate_identity.verified_at = NULL
WHERE duplicate_identity.person_id IS NOT NULL;

ALTER TABLE chat_identities
  ADD UNIQUE KEY uniq_chat_identity_person_platform (person_id, platform);

ALTER TABLE import_jobs
  ADD COLUMN owner_account_id varchar(64) NULL,
  ADD COLUMN source_hash char(64) NULL,
  ADD COLUMN preview_version varchar(64) NULL,
  ADD COLUMN updated_at datetime(3) NULL;

ALTER TABLE import_job_rows
  ADD COLUMN normalized_payload json NULL,
  ADD COLUMN conflict_json json NULL,
  ADD COLUMN decision_json json NULL,
  ADD COLUMN result_action varchar(32) NULL,
  ADD COLUMN updated_at datetime(3) NULL;
```

Seed roles, account rows, and account-role rows from existing `user_groups` and `people`. Use stable IDs `role-{group_id}` and `account-{person_id}`.

- [ ] **Step 4: Add access-control types and JSON defaults**

Create `src/lib/domain/access-control.ts` with fixed codes and storage types:

```ts
import type { MessageChannel, UserGroup } from "./types";

export const PERMISSION_CODES = ["ticket.claim", "ticket.process", "ticket.accept", "admin.access"] as const;
export type PermissionCode = typeof PERMISSION_CODES[number];
export type SessionType = "mobile" | "admin";

export type Account = {
  id: string;
  personId: string;
  loginName: string;
  enabled: boolean;
  authVersion: number;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AccountCredential = {
  accountId: string;
  passwordHash: string;
  passwordChangedAt: string;
  mustChangePassword: boolean;
  failedAttempts: number;
  lockedUntil?: string;
};

export type Role = { id: string; name: string; sourceGroupId: string; enabled: boolean; createdAt: string; updatedAt: string };
export type AccountRole = { accountId: string; roleId: string; createdAt: string };
export type RolePermission = { roleId: string; permissionCode: PermissionCode; createdAt: string };
export type AccountSession = {
  id: string;
  accountId: string;
  sessionType: SessionType;
  tokenHash: string;
  authVersion: number;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt?: string;
  createdAt: string;
};

export type AuthenticatedActor = {
  accountId: string;
  personId: string;
  name: string;
  phone: string;
  groupId: string;
  groupName: string;
  permissions: PermissionCode[];
  sessionType: SessionType;
};

export type MobileAccountInput = {
  name: string;
  phone: string;
  groupId: string;
};

export type UserMutation = {
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  enabled: boolean;
};

export type BootstrapAdminInput = {
  legacyPassword: string;
  name: string;
  phone: string;
  password: string;
  group:
    | { mode: "existing"; groupId: string }
    | { mode: "create"; name: string };
};

export type UserQuery = {
  search?: string;
  groupId?: string;
  enabled?: boolean;
  admin?: boolean;
  binding?: "bound" | "unbound";
  page: number;
  pageSize: number;
};

export type SessionResolution = {
  actor: AuthenticatedActor;
  session: AccountSession;
};

export type AdminLoginRecord = {
  actor: AuthenticatedActor;
  credential: AccountCredential;
};

export type AuthBootstrapState = {
  completedAt?: string;
  completedByAccountId?: string;
};

export type UserListItem = {
  personId: string;
  accountId: string;
  name: string;
  phone: string;
  groupId: string;
  groupName: string;
  groupLocked: boolean;
  enabled: boolean;
  permissions: PermissionCode[];
  hasPassword: boolean;
  lastLoginAt?: string;
  identities: Partial<Record<MessageChannel, { id: string; externalUserId: string; displayName: string }>>;
  updatedAt: string;
};

export function permissionCodesForGroup(group: UserGroup): PermissionCode[] {
  return [
    group.canClaim ? "ticket.claim" : undefined,
    group.canProcess ? "ticket.process" : undefined,
    group.canAccept ? "ticket.accept" : undefined,
    group.canAdmin ? "admin.access" : undefined
  ].filter((code): code is PermissionCode => Boolean(code));
}
```

Add `canAdmin: boolean` to `UserGroup`; add `groupId?: string` and `groupLocked?: boolean` to `Person`. Extend `AppState` and file defaults with `accounts`, `accountCredentials`, `roles`, `accountRoles`, `rolePermissions`, `accountSessions`, and `authBootstrap`.

- [ ] **Step 5: Run targeted tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/db/migration-schema.test.ts tests/domain/access-control.test.ts tests/services/file-store.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- db/migrations/003_user_rbac_management.sql src/lib/domain/access-control.ts src/lib/domain/types.ts src/lib/domain/app-state.ts src/lib/storage/file-store.ts src/lib/seed.ts tests/db/migration-schema.test.ts tests/domain/access-control.test.ts tests/services/file-store.test.ts
git commit -m "feat: add rbac account schema"
```

### Task 2: Add Password And Session Primitives

**Files:**
- Create: `src/lib/services/password-service.ts`
- Create: `src/lib/services/session-service.ts`
- Test: `tests/services/password-service.test.ts`
- Test: `tests/services/session-service.test.ts`

- [ ] **Step 1: Write failing primitive tests**

```ts
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/services/password-service";

describe("password service", () => {
  it("hashes with a random salt and verifies without storing plaintext", async () => {
    const first = await hashPassword("StrongPass123!");
    const second = await hashPassword("StrongPass123!");
    expect(first).not.toBe(second);
    expect(first).not.toContain("StrongPass123!");
    await expect(verifyPassword("StrongPass123!", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong", first)).resolves.toBe(false);
  });
});
```

```ts
import { describe, expect, it } from "vitest";
import { createSessionToken, sessionCookie, sessionTokenHash } from "@/lib/services/session-service";

it("creates opaque tokens and HttpOnly session cookies", () => {
  const token = createSessionToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  expect(sessionTokenHash(token)).toHaveLength(64);
  expect(sessionCookie("mobile", token, new Date("2026-06-12T00:00:00Z"))).toContain("HttpOnly");
  expect(sessionCookie("mobile", token, new Date("2026-06-12T00:00:00Z"))).toContain("SameSite=Lax");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/services/password-service.test.ts tests/services/session-service.test.ts
```

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement `scrypt` password hashing**

Use a versioned format so parameters can change later:

```ts
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 16384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function deriveKey(password: string, salt: Buffer, length: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, length, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string) {
  if (password.length < 10) throw new Error("后台密码至少需要10位");
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, KEY_LENGTH, { N: COST, r: BLOCK_SIZE, p: PARALLELIZATION });
  return ["scrypt", COST, BLOCK_SIZE, PARALLELIZATION, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, cost, blockSize, parallelization, saltText, keyText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !keyText) return false;
  const expected = Buffer.from(keyText, "base64url");
  const actual = await deriveKey(password, Buffer.from(saltText, "base64url"), expected.length, {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelization)
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
```

- [ ] **Step 4: Implement opaque session tokens and cookie helpers**

```ts
import { createHash, randomBytes } from "node:crypto";
import type { SessionType } from "../domain/access-control";

export const SESSION_COOKIE_NAMES = {
  mobile: "board_mobile_session",
  admin: "board_admin_session"
} as const;

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function requestSessionToken(request: Request, type: SessionType) {
  const name = SESSION_COOKIE_NAMES[type];
  return request.headers.get("cookie")?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function sessionCookie(type: SessionType, token: string, expiresAt: Date, secure = process.env.NODE_ENV === "production") {
  return [
    `${SESSION_COOKIE_NAMES[type]}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : undefined,
    `Expires=${expiresAt.toUTCString()}`
  ].filter(Boolean).join("; ");
}

export function expiredSessionCookie(type: SessionType) {
  return `${SESSION_COOKIE_NAMES[type]}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/services/password-service.test.ts tests/services/session-service.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/services/password-service.ts src/lib/services/session-service.ts tests/services/password-service.test.ts tests/services/session-service.test.ts
git commit -m "feat: add password and session primitives"
```

### Task 3: Extend The Repository Contract And JSON Implementation

**Files:**
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/storage/file-store.ts`
- Create: `src/lib/services/access-state-service.ts`
- Test: `tests/repositories/access-file-repository.test.ts`
- Test: `tests/repositories/app-repository.test.ts`

- [ ] **Step 1: Write failing JSON repository tests**

Test mobile upsert, role inheritance, session validation, revocation, and locked groups:

```ts
it("creates a mobile account and preserves a locked group on later login", async () => {
  const state = seededAccessState();
  const repository = createFileAppRepository(memoryStore(state));

  const created = await repository.upsertMobileAccount({
    name: "张三",
    phone: "13800138000",
    groupId: "builder"
  });
  expect(created.actor.permissions).toContain("ticket.process");

  await repository.updateUser(created.actor.personId, { groupLocked: true }, adminActor());
  const relogin = await repository.upsertMobileAccount({
    name: "张三",
    phone: "13800138000",
    groupId: "business"
  });
  expect(relogin.actor.groupId).toBe("builder");
});
```

```ts
it("invalidates sessions when authVersion changes", async () => {
  const repository = createFileAppRepository(memoryStore(seededAccessState()));
  const login = await repository.upsertMobileAccount({ name: "张三", phone: "13800138000", groupId: "builder" });
  const session = await repository.createAccountSession(login.actor.accountId, "mobile", "token-hash", futureIso());
  await repository.revokeAccountSessions(login.actor.accountId);
  await expect(repository.resolveAccountSession(session.tokenHash, "mobile")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify interface failures**

Run:

```powershell
npm.cmd run test:run -- tests/repositories/access-file-repository.test.ts tests/repositories/app-repository.test.ts
```

Expected: FAIL because `AppRepository` has no access-control methods.

- [ ] **Step 3: Add focused repository types and methods**

Add these contracts to `AppRepository`:

```ts
upsertMobileAccount(input: MobileAccountInput): Promise<{ actor: AuthenticatedActor }>;
createAccountSession(accountId: string, type: SessionType, tokenHash: string, expiresAt: string): Promise<AccountSession>;
resolveAccountSession(tokenHash: string, type: SessionType): Promise<SessionResolution | undefined>;
revokeAccountSession(tokenHash: string): Promise<void>;
revokeAccountSessions(accountId: string): Promise<void>;
adminLoginRecord(phone: string): Promise<{ actor: AuthenticatedActor; credential: AccountCredential } | undefined>;
recordAdminLoginFailure(accountId: string, lockedUntil?: string): Promise<void>;
recordAdminLoginSuccess(accountId: string): Promise<void>;
bootstrapStatus(): Promise<{ required: boolean }>;
bootstrapAdmin(input: BootstrapAdminInput): Promise<AuthenticatedActor>;
listUsers(query: UserQuery): Promise<{ users: UserListItem[]; total: number }>;
getUser(userId: string): Promise<UserListItem | undefined>;
createUser(input: UserMutation, actor: AuthenticatedActor): Promise<UserListItem>;
updateUser(userId: string, input: Partial<UserMutation>, actor: AuthenticatedActor): Promise<UserListItem>;
setUserEnabled(userId: string, enabled: boolean, actor: AuthenticatedActor): Promise<UserListItem>;
deleteUser(userId: string, actor: AuthenticatedActor): Promise<void>;
setUserPassword(userId: string, passwordHash: string, actor: AuthenticatedActor): Promise<void>;
syncAccessRoles(userGroups: UserGroup[], actor?: AuthenticatedActor): Promise<void>;
```

- [ ] **Step 4: Implement deterministic JSON state synchronization**

Create `access-state-service.ts` helpers that:

- normalize phone to digits/no spaces;
- create `person-*`, `account-*`, and `role-{groupId}` IDs;
- synchronize roles and role permissions from `UserGroup`;
- maintain exactly one `AccountRole` per account;
- calculate actors only through account-role-role-permission links;
- increment `authVersion` on phone/group/enabled/password changes;
- append structured audit entries without password or raw token data.

Export an atomic file-state updater from `file-store.ts`:

```ts
export async function updateState<T>(operation: (state: AppState) => Promise<T> | T) {
  let result!: T;
  await enqueueStateWrite(async () => {
    const state = await readStateUnlocked();
    result = await operation(state);
    await writeStateUnlocked(state);
  });
  return result;
}
```

Make `createFileAppRepository` use this atomic updater for every access-control mutation, rather than a separate read followed by write.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/repositories/access-file-repository.test.ts tests/repositories/app-repository.test.ts tests/services/file-store.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/repositories/app-repository.ts src/lib/storage/file-store.ts src/lib/services/access-state-service.ts tests/repositories/access-file-repository.test.ts tests/repositories/app-repository.test.ts tests/services/file-store.test.ts
git commit -m "feat: add file backed access repository"
```

### Task 4: Implement MariaDB Access Operations

**Files:**
- Create: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Test: `tests/db/mariadb-access-store.test.ts`
- Test: `tests/db/mariadb-state-store.test.ts`

- [ ] **Step 1: Write failing MariaDB query-contract tests**

Use fake connections to assert:

```ts
it("resolves an active session through account, person, role, and permission joins", async () => {
  const result = await resolveAccountSession(fakeConnection({
    token_hash: "hash",
    session_type: "mobile",
    auth_version: 2,
    account_auth_version: 2,
    account_enabled: 1,
    person_enabled: 1,
    permission_code: "ticket.process"
  }), "hash", "mobile");

  expect(result?.actor.permissions).toEqual(["ticket.process"]);
});

it("updates a mobile user and account role in one transaction", async () => {
  const connection = recordingConnection();
  await upsertMobileAccount(connection, defaultConfig(), {
    name: "张三",
    phone: "13800138000",
    groupId: "builder"
  });
  expect(connection.sql()).toContain("INSERT INTO accounts");
  expect(connection.sql()).toContain("DELETE FROM account_roles");
  expect(connection.sql()).toContain("INSERT INTO account_roles");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/db/mariadb-access-store.test.ts tests/db/mariadb-state-store.test.ts
```

Expected: FAIL because the access store does not exist.

- [ ] **Step 3: Implement focused SQL helpers**

Implement exports with explicit connection parameters:

```ts
export async function syncAccessRoles(connection: DatabaseConnection, groups: UserGroup[], now = new Date()): Promise<void>;
export async function upsertMobileAccount(connection: DatabaseConnection, config: AppConfig, input: MobileAccountInput): Promise<{ actor: AuthenticatedActor }>;
export async function createAccountSession(connection: DatabaseConnection, accountId: string, type: SessionType, tokenHash: string, expiresAt: string): Promise<AccountSession>;
export async function resolveAccountSession(connection: DatabaseConnection, tokenHash: string, type: SessionType): Promise<SessionResolution | undefined>;
export async function revokeAccountSessions(connection: DatabaseConnection, accountId: string, now?: Date): Promise<void>;
export async function adminLoginRecord(connection: DatabaseConnection, phone: string): Promise<AdminLoginRecord | undefined>;
export async function listUsers(connection: DatabaseConnection, query: UserQuery): Promise<{ users: UserListItem[]; total: number }>;
```

Use parameterized SQL only. Session resolution must require:

```sql
s.revoked_at IS NULL
AND s.expires_at > CURRENT_TIMESTAMP(3)
AND s.auth_version = a.auth_version
AND a.enabled = true
AND p.enabled = true
AND r.enabled = true
AND r.source_group_id = p.group_id
```

- [ ] **Step 4: Delegate from `MariaDbStateStore` with transactions**

Each mutation method wraps its helper in `withDatabaseTransaction`. Read methods use the pool directly. `saveConfig` and state imports call `syncAccessRoles(connection, config.userGroups ?? [])` before commit so group flags and RBAC cannot diverge.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/db/mariadb-access-store.test.ts tests/db/mariadb-state-store.test.ts tests/repositories/app-repository.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/db/mariadb-access-store.ts src/lib/db/mariadb-state-store.ts src/lib/repositories/app-repository.ts tests/db/mariadb-access-store.test.ts tests/db/mariadb-state-store.test.ts tests/repositories/app-repository.test.ts
git commit -m "feat: add mariadb access repository"
```

---

## Phase 2: Authentication And Group Permissions

### Task 5: Add Mobile Authentication And Session Resolution

**Files:**
- Create: `src/lib/services/auth-service.ts`
- Create: `src/app/api/auth/mobile/login/route.ts`
- Create: `src/app/api/auth/mobile/logout/route.ts`
- Create: `src/app/api/auth/session/route.ts`
- Create: `src/lib/client/session-auth.ts`
- Modify: `src/app/page.tsx`
- Modify: `src/components/login-panel.tsx`
- Modify: `src/lib/client/auth.ts`
- Test: `tests/services/auth-service.test.ts`
- Test: `tests/api/mobile-auth-routes.test.ts`
- Test: `tests/app/login-auth.test.tsx`

- [ ] **Step 1: Write failing mobile login and locked-group tests**

```ts
it("uses the submitted group for an unlocked existing user", async () => {
  repository.upsertMobileAccount.mockResolvedValue({ actor: actor({ groupId: "business" }) });
  const result = await mobileLogin(repository, { name: "张三", phone: "13800138000", groupId: "business" });
  expect(result.actor.groupId).toBe("business");
  expect(result.cookie).toContain("board_mobile_session=");
});

it("returns the server group when the repository preserves a locked group", async () => {
  repository.upsertMobileAccount.mockResolvedValue({ actor: actor({ groupId: "builder", groupName: "搭建组" }) });
  const result = await mobileLogin(repository, { name: "张三", phone: "13800138000", groupId: "business" });
  expect(result.actor.groupId).toBe("builder");
});
```

Route test:

```ts
const response = await POST(new Request("http://localhost/api/auth/mobile/login", {
  method: "POST",
  body: JSON.stringify({ name: "张三", phone: "13800138000", groupId: "builder" })
}));
expect(response.headers.get("set-cookie")).toContain("HttpOnly");
expect(await response.json()).toEqual({ user: expect.objectContaining({ name: "张三", groupId: "builder" }) });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/services/auth-service.test.ts tests/api/mobile-auth-routes.test.ts tests/app/login-auth.test.tsx
```

Expected: FAIL because server auth routes and session client do not exist.

- [ ] **Step 3: Implement mobile login/logout/session services**

`mobileLogin` validates a Chinese mobile number, checks an enabled group, calls `upsertMobileAccount`, creates a seven-day mobile session, and returns the clear token only to the route:

```ts
export async function mobileLogin(repository: AppRepository, input: MobileLoginInput) {
  if (!/^1[3-9]\d{9}$/.test(normalizePhone(input.phone))) throw new Error("手机号格式不正确");
  const config = await repository.getConfig();
  if (!userGroupsOf(config).some((group) => group.id === input.groupId && group.enabled)) {
    throw new Error("用户分组不存在或已停用");
  }
  const { actor } = await repository.upsertMobileAccount({ ...input, phone: normalizePhone(input.phone) });
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await repository.createAccountSession(actor.accountId, "mobile", sessionTokenHash(token), expiresAt.toISOString());
  return { actor, token, expiresAt };
}
```

Add `resolveRequestActor(request, "mobile" | "admin", requiredPermission?)` and return typed `401`/`403` errors.

- [ ] **Step 4: Replace mobile local-storage identity**

`HomePage` first calls `GET /api/auth/session?type=mobile`. `LoginPanel` posts to `/api/auth/mobile/login`; logout posts to `/api/auth/mobile/logout`. Keep `CurrentUser` as a presentation type but derive it from the server actor:

```ts
export function currentUserFromActor(actor: AuthenticatedActor): CurrentUser {
  return {
    id: actor.personId,
    name: actor.name,
    phone: actor.phone,
    role: "member",
    groupId: actor.groupId,
    groupName: actor.groupName,
    permissions: {
      canClaim: actor.permissions.includes("ticket.claim"),
      canProcess: actor.permissions.includes("ticket.process"),
      canAccept: actor.permissions.includes("ticket.accept")
    }
  };
}
```

Delete `readStoredUser`, `storeUser`, and `clearStoredUser` usage. During rollout, remove the old local-storage key once after a successful session check.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/services/auth-service.test.ts tests/api/mobile-auth-routes.test.ts tests/app/login-auth.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/services/auth-service.ts src/app/api/auth/mobile/login/route.ts src/app/api/auth/mobile/logout/route.ts src/app/api/auth/session/route.ts src/lib/client/session-auth.ts src/app/page.tsx src/components/login-panel.tsx src/lib/client/auth.ts tests/services/auth-service.test.ts tests/api/mobile-auth-routes.test.ts tests/app/login-auth.test.tsx
git commit -m "feat: add server mobile sessions"
```

### Task 6: Add First-Admin Bootstrap And Password Login

**Files:**
- Create: `src/app/api/admin/auth/login/route.ts`
- Create: `src/app/api/admin/auth/logout/route.ts`
- Create: `src/app/api/admin/auth/bootstrap/route.ts`
- Modify: `src/lib/services/auth-service.ts`
- Modify: `src/components/admin-shell.tsx`
- Delete: `src/lib/client/admin-auth.ts`
- Modify: `src/lib/client/auth.ts`
- Test: `tests/api/admin-auth-routes.test.ts`
- Test: `tests/app/admin-page.test.tsx`
- Test: `tests/app/admin-routes.test.tsx`

- [ ] **Step 1: Write failing bootstrap, login, and lockout tests**

```ts
it("allows the legacy password only while bootstrap is incomplete", async () => {
  repository.bootstrapStatus.mockResolvedValue({ required: true });
  const result = await bootstrapFirstAdmin(repository, {
    legacyPassword: "admin123",
    name: "系统管理员",
    phone: "13800138000",
    password: "StrongPass123!",
    group: { mode: "create", name: "系统管理员组" }
  }, { ADMIN_BOOTSTRAP_PASSWORD: "admin123" });
  expect(result.actor.permissions).toContain("admin.access");
});

it("rejects bootstrap after completion", async () => {
  repository.bootstrapStatus.mockResolvedValue({ required: false });
  await expect(bootstrapFirstAdmin(repository, validBootstrapInput(), {})).rejects.toThrow("初始化已完成");
});

it("locks password login after five failures for fifteen minutes", async () => {
  repository.adminLoginRecord.mockResolvedValue(loginRecord({ failedAttempts: 4 }));
  await expect(adminLogin(repository, "13800138000", "wrong")).rejects.toThrow("手机号或密码不正确");
  expect(repository.recordAdminLoginFailure).toHaveBeenCalledWith(expect.any(String), expect.any(String));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/api/admin-auth-routes.test.ts tests/app/admin-page.test.tsx tests/app/admin-routes.test.tsx
```

Expected: FAIL because the admin still uses client-side `admin123`.

- [ ] **Step 3: Implement secure bootstrap and admin login**

Rules:

- legacy password is read only on the server from `ADMIN_BOOTSTRAP_PASSWORD`, with `admin123` as the compatibility default;
- bootstrap creates or updates an admin-enabled group, person, account, role link, password credential, audit row, completion marker, and admin session in one repository transaction;
- admin login requires enabled person/account, valid credential, non-expired lockout, and `admin.access`;
- success resets failed attempts; five consecutive failures lock for fifteen minutes;
- password errors use one generic message.

Route success sets `board_admin_session`; logout expires it.

- [ ] **Step 4: Replace the admin shell login state**

On mount, `AdminBackendShell` calls `/api/auth/session?type=admin`:

```ts
type AdminSessionPayload =
  | { authenticated: true; user: SessionUser }
  | { authenticated: false; bootstrapRequired: boolean };
```

Render:

- bootstrap form when `bootstrapRequired`;
- phone/password form otherwise;
- backend content only after an authenticated server response.

Delete all local-storage admin session calls and remove `DEFAULT_ADMIN_PASSWORD` from client code.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/api/admin-auth-routes.test.ts tests/app/admin-page.test.tsx tests/app/admin-routes.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/app/api/admin/auth/login/route.ts src/app/api/admin/auth/logout/route.ts src/app/api/admin/auth/bootstrap/route.ts src/lib/services/auth-service.ts src/components/admin-shell.tsx src/lib/client/auth.ts tests/api/admin-auth-routes.test.ts tests/app/admin-page.test.tsx tests/app/admin-routes.test.tsx
git rm -- src/lib/client/admin-auth.ts
git commit -m "feat: add admin account authentication"
```

### Task 7: Synchronize `canAdmin` And Protect Every Admin API

**Files:**
- Modify: `src/lib/domain/types.ts`
- Modify: `src/lib/seed.ts`
- Modify: `src/lib/services/config-service.ts`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/app/api/admin/config/route.ts`
- Modify: every existing `src/app/api/admin/**/route.ts`
- Modify: `src/app/api/bootstrap/route.ts`
- Test: `tests/components/admin-panel.test.tsx`
- Test: `tests/api/admin-database-routes.test.ts`
- Test: `tests/api/bootstrap-route.test.ts`
- Test: `tests/services/config-service.test.ts`

- [ ] **Step 1: Write failing admin-permission and route-guard tests**

```ts
it("saves the backend management permission with a group", async () => {
  renderAdminPanel();
  await user.click(screen.getByLabelText("搭建组可管理后台"));
  await user.click(screen.getByRole("button", { name: "保存用户分组配置" }));
  expect(fetch).toHaveBeenCalledWith("/api/admin/config", expect.objectContaining({
    body: expect.stringContaining('"canAdmin":true')
  }));
});
```

```ts
it("rejects admin config reads without an admin session", async () => {
  const response = await route.GET(new Request("http://localhost/api/admin/config"));
  expect(response.status).toBe(401);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-panel.test.tsx tests/api/admin-database-routes.test.ts tests/api/bootstrap-route.test.ts tests/services/config-service.test.ts
```

Expected: FAIL because `canAdmin` is discarded and admin routes are unguarded.

- [ ] **Step 3: Add `canAdmin` to config/UI persistence**

Default groups set `canAdmin: false`. Group form reads and writes:

```tsx
<label className="compact-check-row">
  <input
    name={`group-${group.id}-canAdmin`}
    type="checkbox"
    defaultChecked={group.canAdmin}
    aria-label={`${group.name}可管理后台`}
  />
  后台
</label>
```

`writeConfig` persists `group.canAdmin` instead of hard-coded `false`. Config normalization treats missing legacy values as `false`.

- [ ] **Step 4: Guard all admin data routes**

At the start of every admin route:

```ts
const auth = await requireRequestActor(request, "admin", "admin.access");
if (!auth.ok) return auth.response;
```

Change parameterless `GET()` handlers to `GET(request: Request)`. The unscoped admin bootstrap response also requires an admin session; login/mobile scoped bootstrap behavior remains unchanged.

Before saving group changes, repository logic rejects changes that would leave zero usable admins, where usable means enabled person, enabled account, admin permission, and a credential.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/components/admin-panel.test.tsx tests/api/admin-database-routes.test.ts tests/api/bootstrap-route.test.ts tests/services/config-service.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/domain/types.ts src/lib/seed.ts src/lib/services/config-service.ts src/components/admin-panel.tsx src/app/api/admin src/app/api/bootstrap/route.ts tests/components/admin-panel.test.tsx tests/api/admin-database-routes.test.ts tests/api/bootstrap-route.test.ts tests/services/config-service.test.ts
git commit -m "feat: enforce admin permission on backend routes"
```

---

## Phase 3: User Administration

### Task 8: Implement User CRUD, Last-Admin Protection, And Audit

**Files:**
- Create: `src/lib/services/user-admin-service.ts`
- Create: `src/app/api/admin/users/route.ts`
- Create: `src/app/api/admin/users/[userId]/route.ts`
- Create: `src/app/api/admin/users/[userId]/disable/route.ts`
- Create: `src/app/api/admin/users/[userId]/enable/route.ts`
- Create: `src/app/api/admin/users/[userId]/password/route.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/services/access-state-service.ts`
- Test: `tests/services/user-admin-service.test.ts`
- Test: `tests/api/admin-users-routes.test.ts`
- Test: `tests/repositories/access-file-repository.test.ts`
- Test: `tests/db/mariadb-access-store.test.ts`

- [ ] **Step 1: Write failing CRUD and safety tests**

```ts
it("blocks deletion when the person has business history", async () => {
  repository.userDeletionHistory.mockResolvedValue({ deletable: false, reasons: ["tickets"] });
  await expect(deleteUser(repository, "person-1", adminActor())).rejects.toThrow("该用户已有历史记录，仅可停用");
});

it("allows deletion when only target maintenance audits exist", async () => {
  repository.userDeletionHistory.mockResolvedValue({ deletable: true, reasons: [] });
  await deleteUser(repository, "person-1", adminActor());
  expect(repository.deleteUser).toHaveBeenCalled();
});

it("protects the final usable administrator", async () => {
  repository.usableAdminCount.mockResolvedValue(1);
  await expect(disableUser(repository, "person-admin", adminActor())).rejects.toThrow("必须保留至少一位可用后台管理员");
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/services/user-admin-service.test.ts tests/api/admin-users-routes.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
```

Expected: FAIL because user administration methods and routes do not exist.

- [ ] **Step 3: Implement validation and repository operations**

Use Zod:

```ts
export const userMutationSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  groupId: z.string().min(1).max(64),
  groupLocked: z.boolean(),
  enabled: z.boolean()
});
```

Repository updates person, account login name, account role, `authVersion`, sessions, and audit in one transaction. Changing phone, group, lock, enabled, or password revokes sessions.

MariaDB deletion-history queries include:

- `tickets.reporter_person_id`;
- inbound messages and pending sessions by `person_id`;
- ticket/inbound/outbound/pending references to the user's identity IDs;
- audit rows where the user acted, not rows where the user was merely the target.

- [ ] **Step 4: Implement API responses**

Return:

```ts
GET /api/admin/users -> { users, total, page, pageSize }
POST /api/admin/users -> 201 { user }
PATCH /api/admin/users/{id} -> { user }
DELETE /api/admin/users/{id} -> 204
POST /disable -> { user }
POST /enable -> { user }
POST /password -> 204
```

Map duplicate phone to `409`, missing user to `404`, last-admin/deletion-history conflicts to `409`, validation to `400`.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/services/user-admin-service.test.ts tests/api/admin-users-routes.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/services/user-admin-service.ts src/app/api/admin/users src/lib/repositories/app-repository.ts src/lib/db/mariadb-access-store.ts src/lib/services/access-state-service.ts tests/services/user-admin-service.test.ts tests/api/admin-users-routes.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
git commit -m "feat: add admin user management api"
```

### Task 9: Build The Admin User Management Page

**Files:**
- Create: `src/app/admin/users/page.tsx`
- Create: `src/components/admin-users-panel.tsx`
- Modify: `src/components/admin-panel.tsx`
- Modify: `src/components/admin-shell.tsx`
- Modify: `src/styles/globals.css`
- Test: `tests/app/admin-routes.test.tsx`
- Test: `tests/components/admin-users-panel.test.tsx`

- [ ] **Step 1: Write failing navigation and workflow tests**

```ts
it("shows the user management route in backend navigation", async () => {
  await renderWithAdminSession(<AdminPage />);
  expect(screen.getByRole("link", { name: "用户与权限" }).getAttribute("href")).toBe("/admin/users");
});

it("filters users and edits a locked group", async () => {
  render(<AdminUsersPanel groups={groups} />);
  expect(await screen.findByText("张三")).not.toBeNull();
  await user.type(screen.getByLabelText("搜索用户"), "13800138000");
  await user.click(screen.getByRole("button", { name: "编辑张三" }));
  await user.click(screen.getByLabelText("锁定用户分组"));
  await user.click(screen.getByRole("button", { name: "保存用户" }));
  expect(fetch).toHaveBeenCalledWith("/api/admin/users/person-1", expect.objectContaining({ method: "PATCH" }));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/app/admin-routes.test.tsx tests/components/admin-users-panel.test.tsx
```

Expected: FAIL because the route and component do not exist.

- [ ] **Step 3: Add route and navigation**

Add `users` to `AdminView`, title/description helpers, and nav:

```ts
{ view: "users", label: "用户与权限", href: "/admin/users", icon: UsersRound, group: "manage" }
```

`src/app/admin/users/page.tsx` renders `<AdminBackendShell view="users" />`.

- [ ] **Step 4: Implement the table and editor**

The panel:

- requests server-filtered users with `URLSearchParams`;
- provides search, group, status, admin, and binding filters;
- renders fixed table columns from the design;
- opens an un-nested side panel for create/edit;
- displays inherited permission chips as read-only;
- exposes enable/disable/delete with confirmation;
- exposes password set/reset only when inherited permissions include `admin.access`;
- shows API conflict messages beside the related action.

Use stable responsive grid dimensions:

```css
.admin-user-row {
  display: grid;
  grid-template-columns: minmax(150px, 1.2fr) 120px 110px minmax(150px, 1fr) 120px 120px 92px 116px 80px;
  gap: 8px;
  align-items: center;
  min-height: 52px;
}
```

At widths below 900px, render each row as a labeled record layout; do not horizontally compress text into overlap.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/app/admin-routes.test.tsx tests/components/admin-users-panel.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/app/admin/users/page.tsx src/components/admin-users-panel.tsx src/components/admin-panel.tsx src/components/admin-shell.tsx src/styles/globals.css tests/app/admin-routes.test.tsx tests/components/admin-users-panel.test.tsx
git commit -m "feat: add admin users page"
```

### Task 10: Add WeChat And WeCom Binding Management

**Files:**
- Create: `src/lib/services/chat-identity-admin-service.ts`
- Create: `src/app/api/admin/chat-identities/route.ts`
- Create: `src/app/api/admin/users/[userId]/chat-identities/[platform]/route.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/services/access-state-service.ts`
- Modify: `src/components/admin-users-panel.tsx`
- Test: `tests/services/chat-identity-admin-service.test.ts`
- Test: `tests/api/admin-chat-identity-routes.test.ts`
- Test: `tests/components/admin-users-panel.test.tsx`

- [ ] **Step 1: Write failing binding conflict tests**

```ts
it("requires explicit confirmation before reassigning an occupied identity", async () => {
  repository.identityByExternalId.mockResolvedValue(identity({ personId: "person-other" }));
  await expect(bindIdentity(repository, {
    userId: "person-1",
    platform: "wechat",
    externalUserId: "wxid-1"
  }, adminActor())).rejects.toMatchObject({
    code: "IDENTITY_CONFLICT",
    confirmationToken: expect.any(String)
  });
});

it("allows one identity per platform and replaces the user's old binding", async () => {
  await bindIdentity(repository, confirmedBindingInput(), adminActor());
  expect(repository.bindChatIdentity).toHaveBeenCalledWith(expect.objectContaining({
    platform: "wechat",
    confirmedRebind: true
  }), expect.anything());
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/services/chat-identity-admin-service.test.ts tests/api/admin-chat-identity-routes.test.ts tests/components/admin-users-panel.test.tsx
```

Expected: FAIL because binding services and routes do not exist.

- [ ] **Step 3: Implement signed conflict confirmation**

Generate a short-lived HMAC token over:

```ts
type RebindClaim = {
  platform: MessageChannel;
  identityId: string;
  fromPersonId: string;
  toPersonId: string;
  expiresAt: string;
};
```

Use `AUTH_CONFIRMATION_SECRET`, falling back to `ADMIN_BOOTSTRAP_PASSWORD` only in development. Verify token, exact claim values, and five-minute expiry before rebind.

In a transaction:

1. unbind the target user's current identity for that platform;
2. unbind the selected identity from its current person only when confirmed;
3. bind to the target user;
4. set `verifiedBy: "admin"` and `verifiedAt`;
5. write an audit row.

Reject temporary identities.

- [ ] **Step 4: Add identity controls to the editor**

For each platform, provide:

- select from discovered stable identities;
- manual external ID and display name;
- current binding summary;
- unbind icon button with tooltip;
- conflict dialog naming the current owner and requiring “确认换绑”.

The first request handles normal binding. On `409 IDENTITY_CONFLICT`, store the returned token and display confirmation. The second request sends `confirmationToken`.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/services/chat-identity-admin-service.test.ts tests/api/admin-chat-identity-routes.test.ts tests/components/admin-users-panel.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/services/chat-identity-admin-service.ts src/app/api/admin/chat-identities/route.ts src/app/api/admin/users/[userId]/chat-identities/[platform]/route.ts src/lib/repositories/app-repository.ts src/lib/db/mariadb-access-store.ts src/lib/services/access-state-service.ts src/components/admin-users-panel.tsx tests/services/chat-identity-admin-service.test.ts tests/api/admin-chat-identity-routes.test.ts tests/components/admin-users-panel.test.tsx
git commit -m "feat: manage user chat identities"
```

---

## Phase 4: Import And Authorization Enforcement

### Task 11: Add User Import Parsing And Preview

**Files:**
- Create: `src/lib/domain/user-import.ts`
- Create: `src/lib/services/user-import-service.ts`
- Create: `src/app/api/admin/user-imports/preview/route.ts`
- Create: `src/app/api/admin/user-imports/[jobId]/rows/route.ts`
- Modify: `src/lib/repositories/app-repository.ts`
- Modify: `src/lib/db/mariadb-access-store.ts`
- Modify: `src/lib/services/access-state-service.ts`
- Test: `tests/domain/user-import.test.ts`
- Test: `tests/api/admin-user-import-routes.test.ts`

- [ ] **Step 1: Write failing parser and conflict tests**

```ts
it("normalizes the seven supported template columns", () => {
  expect(parseUserImportRows([{
    姓名: " 张三 ",
    手机号: "138 0013 8000",
    分组: "搭建组",
    分组锁定: "是",
    启用状态: "启用",
    微信账号标识: "wxid-zhang",
    企微账号标识: "wecom-zhang"
  }], groups).rows[0].normalized).toEqual({
    name: "张三",
    phone: "13800138000",
    groupId: "builder",
    groupLocked: true,
    enabled: true,
    wechatExternalUserId: "wxid-zhang",
    wecomExternalUserId: "wecom-zhang"
  });
});

it("marks duplicate file phones and occupied chat identities", async () => {
  const preview = await previewUserImport(repository, importInputWithDuplicates(), adminActor());
  expect(preview.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ conflicts: expect.arrayContaining(["file-phone-duplicate"]) }),
    expect.objectContaining({ conflicts: expect.arrayContaining(["wechat-occupied"]) })
  ]));
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/domain/user-import.test.ts tests/api/admin-user-import-routes.test.ts
```

Expected: FAIL because user import modules and routes do not exist.

- [ ] **Step 3: Implement strict row normalization**

Accepted boolean values:

```ts
const TRUE_VALUES = new Set(["是", "启用", "true", "1"]);
const FALSE_VALUES = new Set(["否", "停用", "false", "0"]);
```

Rows with invalid phone, missing name/group, unknown or disabled group, duplicate phone in file, or duplicate platform ID in file receive explicit conflict codes and cannot be selected for commit.

Allowed decisions:

```ts
export type UserImportDecision =
  | { action: "add"; confirmWechatRebind: boolean; confirmWecomRebind: boolean }
  | { action: "overwrite"; confirmWechatRebind: boolean; confirmWecomRebind: boolean }
  | { action: "skip"; confirmWechatRebind: false; confirmWecomRebind: false };
```

- [ ] **Step 4: Persist preview jobs and decisions**

Preview:

- computes SHA-256 source hash supplied by the UI;
- creates `import_jobs` with type `people`, owner account, status `preview`, and random preview version;
- stores normalized payload, conflict snapshot, and no decision per row;
- returns row categories and allowed actions.

Decision PATCH validates ownership and saves decisions only for valid rows. It never modifies people or identities.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/domain/user-import.test.ts tests/api/admin-user-import-routes.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
```

Expected: PASS.

Commit:

```powershell
git add -- src/lib/domain/user-import.ts src/lib/services/user-import-service.ts src/app/api/admin/user-imports/preview/route.ts src/app/api/admin/user-imports/[jobId]/rows/route.ts src/lib/repositories/app-repository.ts src/lib/db/mariadb-access-store.ts src/lib/services/access-state-service.ts tests/domain/user-import.test.ts tests/api/admin-user-import-routes.test.ts tests/repositories/access-file-repository.test.ts tests/db/mariadb-access-store.test.ts
git commit -m "feat: preview user imports"
```

### Task 12: Add Transactional Import Commit, Report, And Wizard UI

**Files:**
- Create: `src/app/api/admin/user-imports/[jobId]/commit/route.ts`
- Create: `src/app/api/admin/user-imports/[jobId]/route.ts`
- Create: `src/app/api/admin/user-imports/[jobId]/report/route.ts`
- Create: `src/components/admin-user-import.tsx`
- Modify: `src/lib/services/user-import-service.ts`
- Modify: `src/components/admin-users-panel.tsx`
- Modify: `src/styles/globals.css`
- Test: `tests/services/user-import-service.test.ts`
- Test: `tests/api/admin-user-import-routes.test.ts`
- Test: `tests/components/admin-user-import.test.tsx`

- [ ] **Step 1: Write failing stale-preview and all-or-nothing tests**

```ts
it("rejects the complete commit when one selected row changed after preview", async () => {
  repository.loadImportJob.mockResolvedValue(jobWithTwoSelectedRows());
  repository.currentUserVersion.mockResolvedValueOnce("same").mockResolvedValueOnce("changed");
  await expect(commitUserImport(repository, "job-1", adminActor())).rejects.toThrow("导入数据已变化，请重新处理冲突");
  expect(repository.applyUserImport).not.toHaveBeenCalled();
});

it("commits all selected rows in one repository transaction", async () => {
  await commitUserImport(repository, "job-1", adminActor());
  expect(repository.applyUserImport).toHaveBeenCalledWith(expect.objectContaining({
    rows: expect.arrayContaining([expect.objectContaining({ decision: { action: "add" } })])
  }), expect.anything());
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/services/user-import-service.test.ts tests/api/admin-user-import-routes.test.ts tests/components/admin-user-import.test.tsx
```

Expected: FAIL because commit/report/UI do not exist.

- [ ] **Step 3: Implement revalidation and transactional commit**

Before mutation, re-check every selected row:

- existing person's `updatedAt`;
- current group existence/enabled state;
- current owner and `updatedAt` of WeChat/WeCom identities;
- allowed action for current phone existence;
- explicit identity rebind flags.

If any selected row is stale or invalid, update its preview conflict result and abort before mutation. Otherwise the repository applies every selected row, role link, identity binding, import result, and audit event in one transaction/atomic JSON state update.

- [ ] **Step 4: Implement report and three-step UI**

The UI:

1. parses `.xlsx`, `.xls`, `.csv` with XLSX;
2. computes a browser SHA-256 hash and posts rows for preview;
3. displays categories and per-row/bulk add-overwrite-skip decisions;
4. requires explicit checkboxes for occupied identity rebinds;
5. commits and refreshes the user list;
6. downloads `/report` as `.xlsx`.

Report route uses XLSX server-side:

```ts
const sheet = XLSX.utils.json_to_sheet(reportRows);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, sheet, "用户导入结果");
const bytes = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
return new Response(bytes, {
  headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="user-import-${jobId}.xlsx"`
  }
});
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/services/user-import-service.test.ts tests/api/admin-user-import-routes.test.ts tests/components/admin-user-import.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/app/api/admin/user-imports src/components/admin-user-import.tsx src/lib/services/user-import-service.ts src/components/admin-users-panel.tsx src/styles/globals.css tests/services/user-import-service.test.ts tests/api/admin-user-import-routes.test.ts tests/components/admin-user-import.test.tsx
git commit -m "feat: commit and report user imports"
```

### Task 13: Enforce Server Actors On Ticket Operations

**Files:**
- Modify: `src/app/api/bootstrap/route.ts`
- Modify: `src/app/api/tickets/route.ts`
- Modify: `src/app/api/tickets/[ticketId]/route.ts`
- Modify: `src/app/api/tickets/[ticketId]/replies/route.ts`
- Modify: `src/components/ticket-submit-form.tsx`
- Modify: `src/components/ticket-detail.tsx`
- Modify: `src/app/page.tsx`
- Test: `tests/api/bootstrap-route.test.ts`
- Test: `tests/api/tickets-route.test.ts`
- Test: `tests/api/ticket-actions-route.test.ts`
- Test: `tests/api/ticket-detail-route.test.ts`
- Test: `tests/components/ticket-submit-form.test.tsx`
- Test: `tests/components/ticket-detail.test.tsx`

- [ ] **Step 1: Write failing spoofing and permission tests**

```ts
it("ignores spoofed submitter fields and uses the mobile session actor", async () => {
  auth.resolveRequestActor.mockResolvedValue(okActor(builderActor()));
  const response = await POST(request({
    boothNumber: "A01",
    description: "网络断了",
    issueType: "网络",
    imageUrls: [],
    submitterName: "伪造管理员"
  }));
  expect(repository.submitTicket).toHaveBeenCalledWith(expect.objectContaining({
    submitterId: "person-builder",
    submitterName: "搭建王工"
  }));
});

it("rejects claim without ticket.claim", async () => {
  auth.resolveRequestActor.mockResolvedValue(okActor(actor({ permissions: [] })));
  const response = await PATCH(claimRequest(), context);
  expect(response.status).toBe(403);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm.cmd run test:run -- tests/api/bootstrap-route.test.ts tests/api/tickets-route.test.ts tests/api/ticket-actions-route.test.ts tests/api/ticket-detail-route.test.ts tests/components/ticket-submit-form.test.tsx tests/components/ticket-detail.test.tsx
```

Expected: FAIL because routes still trust client actors.

- [ ] **Step 3: Derive all actors and permissions server-side**

Request bodies retain only business data:

```ts
const submitSchema = z.object({
  boothNumber: z.string().min(1),
  description: z.string().min(2),
  imageUrls: z.array(z.string()).default([]),
  issueType: z.string().min(1)
});
```

Action permission map:

```ts
const ACTION_PERMISSION = {
  claim: "ticket.claim",
  progress: "ticket.process",
  accept: "ticket.accept",
  reject: "ticket.accept",
  status: "ticket.process"
} as const;
```

Use actor values for submitter, handler, reply author, group name, and timeline actor. Validate that a processing actor owns the ticket or belongs to the assignment group.

`scope=mobile` bootstrap requires a mobile session. Ticket detail, list, submit, action, and reply routes return `401` for disabled/revoked sessions.

- [ ] **Step 4: Remove actor fields from client payloads**

`TicketSubmitForm` sends no submitter fields. `TicketDetail` sends no actor, author, handler, phone, group, or role fields. Keep client permission checks only for affordance visibility; server checks remain authoritative.

When any fetch returns `401`, `HomePage` clears in-memory user state and returns to login.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
npm.cmd run test:run -- tests/api/bootstrap-route.test.ts tests/api/tickets-route.test.ts tests/api/ticket-actions-route.test.ts tests/api/ticket-detail-route.test.ts tests/components/ticket-submit-form.test.tsx tests/components/ticket-detail.test.tsx
```

Expected: PASS.

Commit:

```powershell
git add -- src/app/api/bootstrap/route.ts src/app/api/tickets src/components/ticket-submit-form.tsx src/components/ticket-detail.tsx src/app/page.tsx tests/api/bootstrap-route.test.ts tests/api/tickets-route.test.ts tests/api/ticket-actions-route.test.ts tests/api/ticket-detail-route.test.ts tests/components/ticket-submit-form.test.tsx tests/components/ticket-detail.test.tsx
git commit -m "feat: enforce session actors on tickets"
```

### Task 14: Complete Migration Compatibility, Audit Coverage, And Full Verification

**Files:**
- Modify: `src/lib/services/wechat-identity-service.ts`
- Modify: `src/lib/db/mariadb-state-store.ts`
- Modify: `scripts/db-import-state.mjs`
- Modify: `README.md`
- Modify: relevant tests under `tests/services`, `tests/db`, `tests/api`, and `tests/app`

- [ ] **Step 1: Write final compatibility tests**

Add tests that:

- WeChat registration creates/synchronizes account and account role.
- Imported legacy JSON state receives accounts/roles without changing person or chat identity IDs.
- audit details never include `password`, `passwordHash`, clear session token, or confirmation secret.
- initialization cannot reopen after completion.
- disabled users fail session resolution in MariaDB and JSON modes.

Example:

```ts
it("registers a WeChat person into the same RBAC account model", () => {
  const person = bindWechatIdentityFromRegistration(state, identity.id, registration);
  synchronizePersonAccess(state, person.id);
  expect(state.accounts).toContainEqual(expect.objectContaining({ personId: person.id }));
  expect(state.accountRoles).toContainEqual(expect.objectContaining({ accountId: `account-${person.id}` }));
});
```

- [ ] **Step 2: Run the compatibility tests and verify failures**

Run:

```powershell
npm.cmd run test:run -- tests/services/wechat-identity-service.test.ts tests/db/import-state.test.ts tests/db/mariadb-state-store.test.ts tests/repositories/access-file-repository.test.ts
```

Expected: FAIL until legacy registration/import paths synchronize RBAC.

- [ ] **Step 3: Update legacy creation/import paths and documentation**

After WeChat registration or legacy state import:

- normalize group ID from current config;
- create or update account;
- synchronize the group role;
- update account-role relation;
- leave existing person and chat identity IDs unchanged.

Document:

- new admin bootstrap environment variable;
- admin phone/password login;
- old browser sessions expiring after upgrade;
- required database migration command;
- user import columns and conflict workflow.

- [ ] **Step 4: Run the complete automated verification**

Run:

```powershell
npm.cmd run test:run
npm.cmd run build
```

Expected: all Vitest suites PASS and Next.js production build exits `0`.

- [ ] **Step 5: Run manual UI verification**

Start the dev server:

```powershell
npm.cmd run dev
```

Verify at desktop width and a narrow browser width:

1. `/admin` shows one-time bootstrap only before initialization.
2. Admin phone/password login succeeds and logout expires the session.
3. `/admin/users` table, filters, editor, identity conflict confirmation, and import wizard do not overlap.
4. A mobile user can choose a group, is auto-created, and receives the server-returned group.
5. Locking that user's group prevents a later mobile selection from changing it.
6. Disabling the user causes the next mobile request to return to login.
7. Claim/process/accept controls match inherited permissions and rejected spoofed requests remain rejected.

Stop the dev server after verification.

- [ ] **Step 6: Commit final compatibility work**

```powershell
git add -- src/lib/services/wechat-identity-service.ts src/lib/db/mariadb-state-store.ts scripts/db-import-state.mjs README.md tests
git commit -m "test: verify rbac user management rollout"
```

---

## Final Acceptance Checklist

- [ ] Mobile login creates or updates a server-side person/account and returns a server session.
- [ ] Locked groups cannot be overwritten by mobile login.
- [ ] Disabled users lose current sessions and cannot log in.
- [ ] Admin bootstrap works exactly once and legacy password login is unavailable afterward.
- [ ] Admin login requires enabled account, password, and `admin.access`.
- [ ] All admin APIs reject missing/invalid admin sessions.
- [ ] Group permissions synchronize to roles and role permissions.
- [ ] User list, filters, create/edit, enable/disable, password reset, and deletion rules work.
- [ ] Last usable administrator cannot be removed or stripped of access.
- [ ] Each user has at most one WeChat and one WeCom binding.
- [ ] Occupied identities require an explicit, short-lived confirmation.
- [ ] Import preview changes no production user data.
- [ ] Import commit revalidates every selected row and is all-or-nothing.
- [ ] Ticket write routes derive identity and permissions from sessions.
- [ ] MariaDB and JSON fallback behavior match.
- [ ] Audit logs contain actor and target context but no secrets.
- [ ] `npm.cmd run test:run` and `npm.cmd run build` pass.
