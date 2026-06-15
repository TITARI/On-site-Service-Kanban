import { createHash, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  PERMISSION_CODES,
  permissionCodesForGroup,
  type AccountCredential,
  type AccountSession,
  type AdminLoginRecord,
  type AuthenticatedActor,
  type BootstrapAdminInput,
  type MobileAccountInput,
  type PermissionCode,
  type SessionResolution,
  type SessionType,
  type UserListItem,
  type UserMutation,
  type UserQuery
} from "../domain/access-control";
import type { PersonRole, UserGroup } from "../domain/types";
import type { AppConfig } from "../seed";
import {
  normalizeMobilePhone,
  normalizeStrictIsoDate,
  sanitizeAuditValue
} from "../services/access-state-service";
import type { DatabaseConnection } from "./connection";

type Row = RowDataPacket & Record<string, unknown>;
type SqlValue = string | number | boolean | Date | null;

const SESSION_TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

async function rows<T extends Row>(
  connection: DatabaseConnection,
  sql: string,
  params: SqlValue[] = []
) {
  const [result] = await connection.execute<T[]>(sql, params);
  return result;
}

async function execute(
  connection: DatabaseConnection,
  sql: string,
  params: SqlValue[] = []
) {
  const [result] = await connection.execute<ResultSetHeader>(sql, params);
  return result;
}

function bool(value: unknown) {
  return value === true || value === 1 || value === "1";
}

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : undefined;
}

function requiredIso(value: unknown) {
  const valueIso = iso(value);
  if (!valueIso) throw new Error("Database date value is invalid");
  return valueIso;
}

function nonEmptyName(value: string) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("User name is required");
  return name;
}

function canonicalSessionHash(tokenHash: string) {
  if (!SESSION_TOKEN_HASH_PATTERN.test(tokenHash)) {
    throw new Error(
      "Session token hash must be a lowercase 64-character hexadecimal SHA-256 digest"
    );
  }
  return tokenHash;
}

function futureDate(value: string, field: string) {
  const date = new Date(normalizeStrictIsoDate(value, field));
  if (date.getTime() <= Date.now()) {
    throw new Error(`${field} must be in the future`);
  }
  return date;
}

function optionalDate(value: string | undefined, field: string) {
  if (value === undefined) return null;
  return new Date(normalizeStrictIsoDate(value, field));
}

function roleId(groupId: string) {
  return `role-${groupId}`;
}

function roleForGroup(group: UserGroup): PersonRole {
  if (group.canAdmin) return "admin";
  if (group.canClaim || group.canProcess) return "handler";
  if (group.canAccept) return "manager";
  return "reporter";
}

function orderedPermissions(values: Iterable<unknown>) {
  const granted = new Set(values);
  return PERMISSION_CODES.filter((code) => granted.has(code));
}

function actorFromRows(
  actorRows: Row[],
  sessionType: SessionType
): AuthenticatedActor | undefined {
  const first = actorRows[0];
  if (!first) return undefined;
  const permissions = orderedPermissions(
    actorRows.map((row) => row.permission_code)
  );
  if (sessionType === "admin" && !permissions.includes("admin.access")) {
    return undefined;
  }
  return {
    accountId: String(first.account_id),
    personId: String(first.person_id),
    name: String(first.person_name),
    phone: String(first.phone),
    groupId: String(first.group_id),
    groupName: String(first.group_name),
    permissions,
    sessionType
  };
}

async function readAuthorizedAccount(
  connection: DatabaseConnection,
  accountId: string,
  sessionType: SessionType
) {
  const actorRows = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       a.auth_version,
       p.id AS person_id,
       p.name AS person_name,
       p.phone,
       p.group_id,
       g.name AS group_name,
       rp.permission_code
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN user_groups g ON g.id = p.group_id AND g.enabled = true
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r
       ON r.id = ar.role_id
      AND r.enabled = true
      AND r.source_group_id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE a.id = ?
       AND a.enabled = true
       AND p.enabled = true
     ORDER BY rp.permission_code`,
    [accountId]
  );
  const actor = actorFromRows(actorRows, sessionType);
  if (!actor) return undefined;
  return {
    actor,
    authVersion: Number(actorRows[0].auth_version)
  };
}

async function readActor(
  connection: DatabaseConnection,
  accountId: string,
  sessionType: SessionType
) {
  return (await readAuthorizedAccount(connection, accountId, sessionType))
    ?.actor;
}

async function writeAudit(
  connection: DatabaseConnection,
  action: string,
  targetType: string,
  targetId: string | undefined,
  detail: Record<string, unknown>,
  actor?: AuthenticatedActor,
  now = new Date()
) {
  await execute(
    connection,
    `INSERT INTO audit_logs (
       id, actor_id, actor_name, action, target_type, target_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `audit-${randomUUID()}`,
      actor?.accountId ?? null,
      actor?.name ?? "system",
      action,
      targetType,
      targetId ?? null,
      JSON.stringify(sanitizeAuditValue(detail)),
      now
    ]
  );
}

async function readGroups(connection: DatabaseConnection) {
  const groupRows = await rows<Row>(
    connection,
    `SELECT
       id, name, description, can_claim, can_process, can_accept, can_admin, enabled
     FROM user_groups
     ORDER BY id`
  );
  return groupRows.map((row): UserGroup => ({
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    canClaim: bool(row.can_claim),
    canProcess: bool(row.can_process),
    canAccept: bool(row.can_accept),
    canAdmin: bool(row.can_admin),
    enabled: bool(row.enabled)
  }));
}

export async function readAccessGroups(connection: DatabaseConnection) {
  return await readGroups(connection);
}

async function readEnabledGroup(
  connection: DatabaseConnection,
  groupId: string
) {
  const [row] = await rows<Row>(
    connection,
    `SELECT
       id, name, description, can_claim, can_process, can_accept, can_admin, enabled
     FROM user_groups
     WHERE id = ? AND enabled = true
     LIMIT 1`,
    [groupId]
  );
  if (!row) throw new Error("User group is disabled or missing");
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ""),
    canClaim: bool(row.can_claim),
    canProcess: bool(row.can_process),
    canAccept: bool(row.can_accept),
    canAdmin: bool(row.can_admin),
    enabled: true
  } satisfies UserGroup;
}

async function upsertRole(
  connection: DatabaseConnection,
  group: UserGroup,
  now: Date
) {
  const id = roleId(group.id);
  await execute(
    connection,
    `INSERT INTO roles (
       id, name, source_group_id, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       source_group_id = VALUES(source_group_id),
       enabled = VALUES(enabled),
       updated_at = VALUES(updated_at)`,
    [id, group.name, group.id, group.enabled, now, now]
  );
  await execute(
    connection,
    "DELETE FROM role_permissions WHERE role_id = ?",
    [id]
  );
  for (const permissionCode of permissionCodesForGroup(group)) {
    await execute(
      connection,
      `INSERT INTO role_permissions (
         role_id, permission_code, created_at
       ) VALUES (?, ?, ?)`,
      [id, permissionCode, now]
    );
  }
}

async function authorizationFingerprints(connection: DatabaseConnection) {
  const fingerprintRows = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       CONCAT_WS(
         '|',
         a.enabled,
         p.enabled,
         COALESCE(p.group_id, ''),
         COALESCE(g.enabled, 0),
         COALESCE(
           GROUP_CONCAT(
             DISTINCT CONCAT_WS(
               ':',
               COALESCE(ar.role_id, ''),
               COALESCE(r.enabled, 0),
               COALESCE(r.source_group_id, ''),
               COALESCE(role_permissions.permission_codes, '')
             )
             ORDER BY ar.role_id, r.source_group_id
             SEPARATOR ';'
           ),
           ''
         )
       ) AS authorization_fingerprint
     FROM accounts a
     LEFT JOIN people p ON p.id = a.person_id
     LEFT JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN account_roles ar ON ar.account_id = a.id
     LEFT JOIN roles r ON r.id = ar.role_id
     LEFT JOIN (
       SELECT
         role_id,
         GROUP_CONCAT(
           DISTINCT permission_code
           ORDER BY permission_code
           SEPARATOR ','
         ) AS permission_codes
       FROM role_permissions
       GROUP BY role_id
     ) role_permissions ON role_permissions.role_id = r.id
     GROUP BY
       a.id, a.enabled, p.enabled, p.group_id, g.enabled
     ORDER BY a.id`
  );
  const fingerprints = new Map<string, string[]>();
  for (const row of fingerprintRows) {
    const accountId = String(row.account_id);
    const values = fingerprints.get(accountId) ?? [];
    values.push(String(row.authorization_fingerprint));
    fingerprints.set(accountId, values);
  }
  return new Map(
    [...fingerprints].map(([accountId, values]) => [
      accountId,
      values.sort().join("\n")
    ])
  );
}

async function usableAdminCount(connection: DatabaseConnection) {
  const [record] = await rows<Row>(
    connection,
    `SELECT COUNT(DISTINCT a.id) AS count
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN account_credentials c
       ON c.account_id = a.id
      AND c.password_hash <> ''
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r
       ON r.id = ar.role_id
      AND r.source_group_id = p.group_id
      AND r.enabled = true
     JOIN role_permissions rp
       ON rp.role_id = r.id
      AND rp.permission_code = 'admin.access'
     WHERE a.enabled = true
       AND p.enabled = true`
  );
  return Number(record?.count ?? 0);
}

async function synchronizeAccountRole(
  connection: DatabaseConnection,
  accountId: string,
  groupId: string,
  now: Date
) {
  await execute(
    connection,
    "DELETE FROM account_roles WHERE account_id = ?",
    [accountId]
  );
  await execute(
    connection,
    `INSERT INTO account_roles (account_id, role_id, created_at)
     VALUES (?, ?, ?)`,
    [accountId, roleId(groupId), now]
  );
}

async function invalidateAccount(
  connection: DatabaseConnection,
  accountId: string,
  now: Date
) {
  await execute(
    connection,
    `UPDATE accounts
     SET auth_version = auth_version + 1, updated_at = ?
     WHERE id = ?`,
    [now, accountId]
  );
  await execute(
    connection,
    `UPDATE account_sessions
     SET revoked_at = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [now, accountId]
  );
}

export async function syncAccessRoles(
  connection: DatabaseConnection,
  groups: UserGroup[],
  now = new Date()
): Promise<void> {
  const before = await authorizationFingerprints(connection);
  const hadUsableAdminAccount = await usableAdminCount(connection) > 0;
  const incomingGroupIds = new Set(groups.map((group) => group.id));
  const referencedRows = await rows<Row>(
    connection,
    "SELECT DISTINCT group_id FROM people WHERE group_id IS NOT NULL"
  );
  const referencedGroupIds = new Set(
    referencedRows.map((row) => String(row.group_id))
  );

  for (const group of groups) {
    await upsertRole(connection, group, now);
  }
  for (const groupId of referencedGroupIds) {
    if (incomingGroupIds.has(groupId)) continue;
    await upsertRole(connection, {
      id: groupId,
      name: groupId,
      description: "",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: false,
      enabled: false
    }, now);
  }

  const retainedGroupIds = new Set([
    ...incomingGroupIds,
    ...referencedGroupIds
  ]);
  const existingRoles = await rows<Row>(
    connection,
    "SELECT id, source_group_id FROM roles"
  );
  for (const role of existingRoles) {
    if (retainedGroupIds.has(String(role.source_group_id))) continue;
    const id = String(role.id);
    await execute(
      connection,
      "DELETE FROM role_permissions WHERE role_id = ?",
      [id]
    );
    await execute(
      connection,
      "DELETE FROM account_roles WHERE role_id = ?",
      [id]
    );
    await execute(connection, "DELETE FROM roles WHERE id = ?", [id]);
  }

  await execute(connection, "DELETE FROM account_roles");
  await execute(
    connection,
    `INSERT INTO account_roles (account_id, role_id, created_at)
     SELECT a.id, r.id, ?
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN roles r ON r.source_group_id = p.group_id
     WHERE p.group_id IS NOT NULL`,
    [now]
  );

  if (hadUsableAdminAccount && await usableAdminCount(connection) < 1) {
    throw new Error("At least one usable admin account is required");
  }

  const after = await authorizationFingerprints(connection);
  for (const [accountId, fingerprint] of after) {
    if (before.get(accountId) === fingerprint) continue;
    await invalidateAccount(connection, accountId, now);
  }
}

function enabledConfigGroup(config: AppConfig, groupId: string) {
  const group = config.userGroups?.find((item) => item.id === groupId);
  if (!group?.enabled) throw new Error("User group is disabled or missing");
  return group;
}

type AccountPersonRow = Row & {
  person_id: string;
  account_id?: string;
};

type DuplicatePhoneOwnerRow = Row & {
  owner_person_id?: string | null;
  owner_account_id?: string | null;
  owner_source: "people" | "accounts";
};

async function duplicatePhoneOwners(
  connection: DatabaseConnection,
  phone: string,
  exclude: { personId?: string; accountId?: string } = {}
) {
  const excludedPersonId = exclude.personId ?? null;
  const excludedAccountId = exclude.accountId ?? null;
  return await rows<DuplicatePhoneOwnerRow>(
    connection,
    `SELECT *
     FROM (
       SELECT
         p.id AS owner_person_id,
         NULL AS owner_account_id,
         'people' AS owner_source
       FROM people p
       WHERE p.phone = ?
       UNION ALL
       SELECT
         a.person_id AS owner_person_id,
         a.id AS owner_account_id,
         'accounts' AS owner_source
       FROM accounts a
       WHERE a.login_name = ?
     ) duplicate_phone_owners
     WHERE (? IS NULL OR owner_person_id IS NULL OR owner_person_id <> ?)
       AND (? IS NULL OR owner_account_id IS NULL OR owner_account_id <> ?)
     LIMIT 1`,
    [
      phone,
      phone,
      excludedPersonId,
      excludedPersonId,
      excludedAccountId,
      excludedAccountId
    ]
  );
}

async function assertPhoneAvailable(
  connection: DatabaseConnection,
  phone: string,
  exclude: { personId?: string; accountId?: string } = {}
) {
  const [duplicate] = await duplicatePhoneOwners(connection, phone, exclude);
  if (duplicate) {
    throw new Error("Mobile phone is already assigned to another user");
  }
}

async function findAccountPersonByPhone(
  connection: DatabaseConnection,
  phone: string
) {
  const records = await rows<AccountPersonRow>(
    connection,
    `SELECT
       p.id AS person_id,
       p.name AS person_name,
       p.phone,
       p.group_id,
       p.group_locked,
       p.enabled AS person_enabled,
       a.id AS account_id,
       a.enabled AS account_enabled,
       a.auth_version
     FROM people p
     LEFT JOIN accounts a ON a.person_id = p.id
     WHERE p.phone = ? OR a.login_name = ?
     ORDER BY p.id, a.id`,
    [phone, phone]
  );
  if (records.length > 1) {
    throw new Error(
      "Mobile phone matches multiple access records; resolve duplicate people/accounts before login"
    );
  }
  return records[0];
}

export async function upsertMobileAccount(
  connection: DatabaseConnection,
  config: AppConfig,
  input: MobileAccountInput
): Promise<{ actor: AuthenticatedActor }> {
  const phone = normalizeMobilePhone(input.phone);
  const name = nonEmptyName(input.name);
  const existing = await findAccountPersonByPhone(connection, phone);
  const existingGroupId = existing?.group_id
    ? String(existing.group_id)
    : undefined;
  const selectedGroupId = existing && bool(existing.group_locked)
    ? existingGroupId
    : input.groupId;
  if (!selectedGroupId) throw new Error("Mobile account has no user group");
  const selectedGroup = enabledConfigGroup(config, selectedGroupId);
  const groups = config.userGroups ?? [];
  const now = new Date();
  await syncAccessRoles(connection, groups, now);

  let personId: string;
  let accountId: string;
  let created = false;

  if (!existing) {
    created = true;
    personId = `person-${randomUUID()}`;
    accountId = `account-${personId}`;
    await execute(
      connection,
      `INSERT INTO people (
         id, name, phone, role, group_id, group_name_snapshot, group_locked,
         name_conflict, booth_scope, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personId,
        name,
        phone,
        roleForGroup(selectedGroup),
        selectedGroup.id,
        selectedGroup.name,
        false,
        null,
        null,
        true,
        now,
        now
      ]
    );
    await execute(
      connection,
      `INSERT INTO accounts (
         id, person_id, login_name, enabled, auth_version,
         last_login_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, personId, phone, true, 1, now, now, now]
    );
    await synchronizeAccountRole(
      connection,
      accountId,
      selectedGroup.id,
      now
    );
  } else {
    if (!existing.account_id) {
      personId = String(existing.person_id);
      accountId = `account-${personId}`;
      await execute(
        connection,
        `INSERT INTO accounts (
           id, person_id, login_name, enabled, auth_version,
           last_login_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, personId, phone, true, 1, now, now, now]
      );
    } else {
      personId = String(existing.person_id);
      accountId = String(existing.account_id);
      if (!bool(existing.person_enabled) || !bool(existing.account_enabled)) {
        throw new Error("Mobile account is disabled");
      }
    }

    const groupChanged = existingGroupId !== selectedGroup.id;

    await execute(
      connection,
      `UPDATE people
       SET name = ?, phone = ?, role = ?, group_id = ?,
           group_name_snapshot = ?, updated_at = ?
       WHERE id = ?`,
      [
        name,
        phone,
        roleForGroup(selectedGroup),
        selectedGroup.id,
        selectedGroup.name,
        now,
        personId
      ]
    );
    await execute(
      connection,
      `UPDATE accounts
       SET login_name = ?, last_login_at = ?, updated_at = ?
       WHERE id = ?`,
      [phone, now, now, accountId]
    );
    await synchronizeAccountRole(
      connection,
      accountId,
      selectedGroup.id,
      now
    );
    if (groupChanged) {
      await invalidateAccount(connection, accountId, now);
    }
  }

  const actor = await readActor(connection, accountId, "mobile");
  if (!actor) throw new Error("Mobile account access chain is disabled");
  await writeAudit(
    connection,
    "mobile.account.upsert",
    "user",
    personId,
    {
      accountId,
      groupId: actor.groupId,
      created
    },
    actor,
    now
  );
  return { actor };
}

export async function createAccountSession(
  connection: DatabaseConnection,
  accountId: string,
  type: SessionType,
  tokenHashInput: string,
  expiresAtInput: string
): Promise<AccountSession> {
  const tokenHash = canonicalSessionHash(tokenHashInput);
  const expiresAt = futureDate(expiresAtInput, "Session expiresAt");
  const authorized = await readAuthorizedAccount(
    connection,
    accountId,
    type
  );
  if (!authorized) {
    throw new Error("Account is not allowed to create this session");
  }

  const now = new Date();
  const session: AccountSession = {
    id: `session-${randomUUID()}`,
    accountId,
    sessionType: type,
    tokenHash,
    authVersion: authorized.authVersion,
    expiresAt: expiresAt.toISOString(),
    lastSeenAt: now.toISOString(),
    createdAt: now.toISOString()
  };
  await execute(
    connection,
    `INSERT INTO account_sessions (
       id, account_id, session_type, token_hash, auth_version,
       expires_at, last_seen_at, revoked_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      session.id,
      accountId,
      type,
      tokenHash,
      session.authVersion,
      expiresAt,
      now,
      null,
      now
    ]
  );
  return session;
}

export async function resolveAccountSession(
  connection: DatabaseConnection,
  tokenHashInput: string,
  type: SessionType
): Promise<SessionResolution | undefined> {
  const tokenHash = canonicalSessionHash(tokenHashInput);
  const sessionRows = await rows<Row>(
    connection,
    `SELECT
       s.id AS session_id,
       s.account_id,
       s.session_type,
       s.token_hash,
       s.auth_version AS session_auth_version,
       s.expires_at,
       s.last_seen_at,
       s.revoked_at,
       s.created_at AS session_created_at,
       p.id AS person_id,
       p.name AS person_name,
       p.phone,
       p.group_id,
       g.name AS group_name,
       rp.permission_code
     FROM account_sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN people p ON p.id = a.person_id
     JOIN user_groups g ON g.id = p.group_id AND g.enabled = true
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r ON r.id = ar.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE s.token_hash = ?
       AND s.session_type = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > UTC_TIMESTAMP(3)
       AND s.auth_version = a.auth_version
       AND a.enabled = true
       AND p.enabled = true
       AND r.enabled = true
       AND r.source_group_id = p.group_id
     ORDER BY rp.permission_code`,
    [tokenHash, type]
  );
  const first = sessionRows[0];
  if (!first) return undefined;
  const actor = actorFromRows(sessionRows, type);
  if (!actor) return undefined;
  const session: AccountSession = {
    id: String(first.session_id),
    accountId: String(first.account_id),
    sessionType: first.session_type as SessionType,
    tokenHash: String(first.token_hash),
    authVersion: Number(first.session_auth_version),
    expiresAt: requiredIso(first.expires_at),
    lastSeenAt: requiredIso(first.last_seen_at),
    revokedAt: iso(first.revoked_at),
    createdAt: requiredIso(first.session_created_at)
  };
  return { session, actor };
}

export async function revokeAccountSession(
  connection: DatabaseConnection,
  tokenHashInput: string,
  now = new Date()
): Promise<void> {
  const tokenHash = canonicalSessionHash(tokenHashInput);
  const [session] = await rows<Row>(
    connection,
    `SELECT id, account_id, session_type, revoked_at
     FROM account_sessions
     WHERE token_hash = ?
     LIMIT 1`,
    [tokenHash]
  );
  if (!session || session.revoked_at) return;
  await execute(
    connection,
    `UPDATE account_sessions
     SET revoked_at = ?
     WHERE token_hash = ? AND revoked_at IS NULL`,
    [now, tokenHash]
  );
  await writeAudit(
    connection,
    "session.revoke",
    "session",
    String(session.id),
    {
      accountId: String(session.account_id),
      sessionId: String(session.id),
      sessionType: String(session.session_type)
    },
    undefined,
    now
  );
}

export async function revokeAccountSessions(
  connection: DatabaseConnection,
  accountId: string,
  now = new Date()
): Promise<void> {
  const accountUpdate = await execute(
    connection,
    `UPDATE accounts
     SET auth_version = auth_version + 1, updated_at = ?
     WHERE id = ?`,
    [now, accountId]
  );
  if (accountUpdate.affectedRows < 1) return;
  const sessionUpdate = await execute(
    connection,
    `UPDATE account_sessions
     SET revoked_at = ?
     WHERE account_id = ? AND revoked_at IS NULL`,
    [now, accountId]
  );
  await writeAudit(
    connection,
    "sessions.revoke",
    "account",
    accountId,
    { accountId, revokedCount: sessionUpdate.affectedRows },
    undefined,
    now
  );
}

export async function adminLoginRecord(
  connection: DatabaseConnection,
  phoneInput: string
): Promise<AdminLoginRecord | undefined> {
  let phone: string;
  try {
    phone = normalizeMobilePhone(phoneInput);
  } catch {
    return undefined;
  }
  const loginRows = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       p.id AS person_id,
       p.name AS person_name,
       p.phone,
       p.group_id,
       g.name AS group_name,
       rp.permission_code,
       c.password_hash,
       c.password_changed_at,
       c.must_change_password,
       c.failed_attempts,
       c.locked_until
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN user_groups g ON g.id = p.group_id AND g.enabled = true
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r
       ON r.id = ar.role_id
      AND r.enabled = true
      AND r.source_group_id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     JOIN account_credentials c ON c.account_id = a.id
     WHERE a.login_name = ?
       AND a.enabled = true
       AND p.enabled = true
     ORDER BY rp.permission_code`,
    [phone]
  );
  const first = loginRows[0];
  const actor = actorFromRows(loginRows, "admin");
  if (!first || !actor) return undefined;
  const credential: AccountCredential = {
    accountId: actor.accountId,
    passwordHash: String(first.password_hash),
    passwordChangedAt: requiredIso(first.password_changed_at),
    mustChangePassword: bool(first.must_change_password),
    failedAttempts: Number(first.failed_attempts ?? 0),
    lockedUntil: iso(first.locked_until)
  };
  return { actor, credential };
}

export async function recordAdminLoginFailure(
  connection: DatabaseConnection,
  accountId: string,
  lockedUntilInput?: string,
  now = new Date()
): Promise<void> {
  const lockedUntil = optionalDate(lockedUntilInput, "lockedUntil");
  const result = await execute(
    connection,
    `UPDATE account_credentials
     SET failed_attempts = failed_attempts + 1,
         locked_until = COALESCE(?, locked_until)
     WHERE account_id = ?`,
    [lockedUntil, accountId]
  );
  if (result.affectedRows < 1) {
    throw new Error("Admin credential was not found");
  }
  const [credential] = await rows<Row>(
    connection,
    `SELECT failed_attempts, locked_until
     FROM account_credentials
     WHERE account_id = ?
     LIMIT 1`,
    [accountId]
  );
  await writeAudit(
    connection,
    "admin.login.failure",
    "account",
    accountId,
    {
      failedAttempts: Number(credential?.failed_attempts ?? 0),
      lockedUntil: iso(credential?.locked_until)
    },
    undefined,
    now
  );
}

export async function recordAdminLoginSuccess(
  connection: DatabaseConnection,
  accountId: string,
  now = new Date()
): Promise<void> {
  const result = await execute(
    connection,
    `UPDATE account_credentials
     SET failed_attempts = 0, locked_until = NULL
     WHERE account_id = ?`,
    [accountId]
  );
  if (result.affectedRows < 1) {
    throw new Error("Admin credential was not found");
  }
  await execute(
    connection,
    `UPDATE accounts
     SET last_login_at = ?, updated_at = ?
     WHERE id = ?`,
    [now, now, accountId]
  );
  await writeAudit(
    connection,
    "admin.login.success",
    "account",
    accountId,
    {},
    await readActor(connection, accountId, "admin"),
    now
  );
}

export async function bootstrapStatus(connection: DatabaseConnection) {
  const [state] = await rows<Row>(
    connection,
    `SELECT completed_at
     FROM auth_bootstrap_state
     WHERE id = ?
     LIMIT 1`,
    ["admin"]
  );
  return { required: !state?.completed_at };
}

function createdAdminGroupId(name: string) {
  return `admin-${createHash("sha256")
    .update(name.trim().toLowerCase())
    .digest("base64url")
    .slice(0, 16)}`;
}

export async function bootstrapAdmin(
  connection: DatabaseConnection,
  input: BootstrapAdminInput,
  passwordHash: string
) {
  const [bootstrap] = await rows<Row>(
    connection,
    `SELECT completed_at
     FROM auth_bootstrap_state
     WHERE id = ?
     FOR UPDATE`,
    ["admin"]
  );
  if (bootstrap?.completed_at) {
    throw new Error("Admin bootstrap has already completed");
  }
  if (!input.legacyPassword.trim()) {
    throw new Error("Legacy password is required");
  }

  let groupId: string;
  if (input.group.mode === "existing") {
    groupId = input.group.groupId;
    const result = await execute(
      connection,
      `UPDATE user_groups
       SET enabled = true, can_admin = true, updated_at = ?
       WHERE id = ?`,
      [new Date(), groupId]
    );
    if (result.affectedRows < 1) {
      throw new Error("Bootstrap admin group was not found");
    }
  } else {
    const groupName = nonEmptyName(input.group.name);
    const baseId = createdAdminGroupId(groupName);
    const existingIds = new Set(
      (await rows<Row>(
        connection,
        "SELECT id FROM user_groups WHERE id LIKE ?",
        [`${baseId}%`]
      )).map((row) => String(row.id))
    );
    groupId = baseId;
    let suffix = 1;
    while (existingIds.has(groupId)) {
      groupId = `${baseId}-${suffix}`;
      suffix += 1;
    }
    const now = new Date();
    await execute(
      connection,
      `INSERT INTO user_groups (
         id, name, description, can_claim, can_process, can_accept,
         can_admin, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        groupId,
        groupName,
        "Bootstrap administrators",
        false,
        false,
        false,
        true,
        true,
        now,
        now
      ]
    );
  }

  const groups = await readGroups(connection);
  await syncAccessRoles(connection, groups);
  const group = groups.find((item) => item.id === groupId);
  if (!group) throw new Error("Bootstrap admin group was not found");

  const phone = normalizeMobilePhone(input.phone);
  const name = nonEmptyName(input.name);
  const existing = await findAccountPersonByPhone(connection, phone);
  const now = new Date();
  let personId: string;
  let accountId: string;
  if (!existing) {
    personId = `person-${randomUUID()}`;
    accountId = `account-${personId}`;
    await execute(
      connection,
      `INSERT INTO people (
         id, name, phone, role, group_id, group_name_snapshot, group_locked,
         name_conflict, booth_scope, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personId,
        name,
        phone,
        "admin",
        group.id,
        group.name,
        true,
        null,
        null,
        true,
        now,
        now
      ]
    );
    await execute(
      connection,
      `INSERT INTO accounts (
         id, person_id, login_name, enabled, auth_version,
         last_login_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, personId, phone, true, 1, null, now, now]
    );
  } else {
    personId = String(existing.person_id);
    accountId = existing.account_id
      ? String(existing.account_id)
      : `account-${personId}`;
    await execute(
      connection,
      `UPDATE people
       SET name = ?, phone = ?, role = 'admin', group_id = ?,
           group_name_snapshot = ?, group_locked = true,
           enabled = true, updated_at = ?
       WHERE id = ?`,
      [name, phone, group.id, group.name, now, personId]
    );
    if (existing.account_id) {
      await execute(
        connection,
        `UPDATE accounts
         SET login_name = ?, enabled = true, updated_at = ?
         WHERE id = ?`,
        [phone, now, accountId]
      );
      await invalidateAccount(connection, accountId, now);
    } else {
      await execute(
        connection,
        `INSERT INTO accounts (
           id, person_id, login_name, enabled, auth_version,
           last_login_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [accountId, personId, phone, true, 1, null, now, now]
      );
    }
  }
  await synchronizeAccountRole(connection, accountId, group.id, now);
  await execute(
    connection,
    `INSERT INTO account_credentials (
       account_id, password_hash, password_changed_at, must_change_password,
       failed_attempts, locked_until
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       password_changed_at = VALUES(password_changed_at),
       must_change_password = VALUES(must_change_password),
       failed_attempts = 0,
       locked_until = NULL`,
    [accountId, passwordHash, now, false, 0, null]
  );
  await execute(
    connection,
    `INSERT INTO auth_bootstrap_state (
       id, completed_at, completed_by_account_id
     ) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       completed_at = VALUES(completed_at),
       completed_by_account_id = VALUES(completed_by_account_id)`,
    ["admin", now, accountId]
  );
  const actor = await readActor(connection, accountId, "admin");
  if (!actor) throw new Error("Bootstrap admin access chain is invalid");
  await writeAudit(
    connection,
    "admin.bootstrap",
    "account",
    accountId,
    { accountId, personId, groupId: group.id },
    actor,
    now
  );
  return actor;
}

type UserFilter = {
  sql: string;
  params: SqlValue[];
};

function userFilter(query: UserQuery): UserFilter {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const search = query.search?.trim().toLowerCase();
  if (search) {
    clauses.push(`(
      LOWER(CONCAT_WS(' ', p.name, p.phone, COALESCE(g.name, ''))) LIKE ?
      OR EXISTS (
        SELECT 1
        FROM chat_identities search_ci
        WHERE search_ci.person_id = p.id
          AND LOWER(CONCAT_WS(
            ' ',
            search_ci.external_user_id,
            search_ci.display_name,
            search_ci.platform
          )) LIKE ?
      )
    )`);
    const pattern = `%${search}%`;
    params.push(pattern, pattern);
  }
  if (query.groupId !== undefined) {
    clauses.push("p.group_id = ?");
    params.push(query.groupId);
  }
  if (query.enabled !== undefined) {
    const effectiveEnabled = "(p.enabled = true AND a.enabled = true)";
    clauses.push(query.enabled
      ? effectiveEnabled
      : `NOT ${effectiveEnabled}`);
  }
  if (query.admin !== undefined) {
    clauses.push(`${query.admin ? "" : "NOT "}EXISTS (
      SELECT 1
      FROM account_roles filter_ar
      JOIN roles filter_r
        ON filter_r.id = filter_ar.role_id
       AND filter_r.enabled = true
       AND filter_r.source_group_id = p.group_id
      JOIN user_groups filter_g
        ON filter_g.id = p.group_id
       AND filter_g.enabled = true
      JOIN role_permissions filter_rp ON filter_rp.role_id = filter_r.id
      WHERE filter_ar.account_id = a.id
        AND p.enabled = true
        AND a.enabled = true
        AND filter_rp.permission_code = 'admin.access'
    )`);
  }
  if (query.binding !== undefined) {
    clauses.push(`${query.binding === "bound" ? "" : "NOT "}EXISTS (
      SELECT 1
      FROM chat_identities filter_ci
      WHERE filter_ci.person_id = p.id
    )`);
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params
  };
}

const USER_DETAIL_SELECT = `SELECT
  p.id AS person_id,
  a.id AS account_id,
  p.name AS person_name,
  p.phone,
  p.group_id,
  COALESCE(g.name, p.group_name_snapshot) AS group_name,
  p.group_locked,
  p.enabled AS person_enabled,
  a.enabled AS account_enabled,
  a.last_login_at,
  p.updated_at AS person_updated_at,
  a.updated_at AS account_updated_at,
  (c.password_hash IS NOT NULL AND c.password_hash <> '') AS has_password,
  rp.permission_code,
  ci.platform AS identity_platform,
  ci.id AS identity_id,
  ci.external_user_id,
  ci.display_name AS identity_display_name`;

function usersFromRows(userRows: Row[]) {
  const users = new Map<string, {
    item: UserListItem;
    permissions: Set<PermissionCode>;
  }>();
  for (const row of userRows) {
    const personId = String(row.person_id);
    let entry = users.get(personId);
    if (!entry) {
      const personUpdatedAt = requiredIso(row.person_updated_at);
      const accountUpdatedAt = requiredIso(row.account_updated_at);
      entry = {
        item: {
          personId,
          accountId: String(row.account_id),
          name: String(row.person_name),
          phone: String(row.phone),
          groupId: String(row.group_id ?? ""),
          groupName: String(row.group_name ?? ""),
          groupLocked: bool(row.group_locked),
          enabled: bool(row.person_enabled) && bool(row.account_enabled),
          permissions: [],
          hasPassword: bool(row.has_password),
          lastLoginAt: iso(row.last_login_at),
          identities: {},
          updatedAt: personUpdatedAt > accountUpdatedAt
            ? personUpdatedAt
            : accountUpdatedAt
        },
        permissions: new Set()
      };
      users.set(personId, entry);
    }
    if (
      entry.item.enabled &&
      row.permission_code &&
      PERMISSION_CODES.includes(row.permission_code as PermissionCode)
    ) {
      entry.permissions.add(row.permission_code as PermissionCode);
    }
    if (row.identity_platform && row.identity_id) {
      const platform = String(row.identity_platform) as keyof UserListItem["identities"];
      entry.item.identities[platform] = {
        id: String(row.identity_id),
        externalUserId: String(row.external_user_id),
        displayName: String(row.identity_display_name)
      };
    }
  }
  return [...users.values()].map((entry) => ({
    ...entry.item,
    permissions: orderedPermissions(entry.permissions)
  }));
}

export async function listUsers(
  connection: DatabaseConnection,
  query: UserQuery
): Promise<{ users: UserListItem[]; total: number }> {
  const filter = userFilter(query);
  const [countRow] = await rows<Row>(
    connection,
    `SELECT COUNT(*) AS total
     FROM people p
     JOIN accounts a ON a.person_id = p.id
     LEFT JOIN user_groups g ON g.id = p.group_id
     ${filter.sql}`,
    filter.params
  );
  const page = Math.max(1, Math.trunc(query.page));
  const pageSize = Math.max(1, Math.trunc(query.pageSize));
  const offset = (page - 1) * pageSize;
  const userRows = await rows<Row>(
    connection,
    `${USER_DETAIL_SELECT}
     FROM (
       SELECT p.id AS person_id
       FROM people p
       JOIN accounts a ON a.person_id = p.id
       LEFT JOIN user_groups g ON g.id = p.group_id
       ${filter.sql}
       ORDER BY p.name, p.id
       LIMIT ? OFFSET ?
     ) paged_users
     JOIN people p ON p.id = paged_users.person_id
     JOIN accounts a ON a.person_id = p.id
     LEFT JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN account_roles ar ON ar.account_id = a.id
     LEFT JOIN roles r
       ON r.id = ar.role_id
      AND r.source_group_id = p.group_id
      AND r.enabled = true
      AND g.enabled = true
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN account_credentials c ON c.account_id = a.id
     LEFT JOIN chat_identities ci ON ci.person_id = p.id
     ORDER BY p.name, p.id, ci.platform, rp.permission_code`,
    [...filter.params, pageSize, offset]
  );
  return {
    users: usersFromRows(userRows),
    total: Number(countRow?.total ?? 0)
  };
}

export async function getUser(
  connection: DatabaseConnection,
  userId: string
) {
  const userRows = await rows<Row>(
    connection,
    `${USER_DETAIL_SELECT}
     FROM people p
     JOIN accounts a ON a.person_id = p.id
     LEFT JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN account_roles ar ON ar.account_id = a.id
     LEFT JOIN roles r
       ON r.id = ar.role_id
      AND r.source_group_id = p.group_id
      AND r.enabled = true
      AND g.enabled = true
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN account_credentials c ON c.account_id = a.id
     LEFT JOIN chat_identities ci ON ci.person_id = p.id
     WHERE p.id = ? OR a.id = ?
     ORDER BY ci.platform, rp.permission_code`,
    [userId, userId]
  );
  return usersFromRows(userRows)[0];
}

async function ensureGroupRole(
  connection: DatabaseConnection,
  group: UserGroup,
  now: Date
) {
  await upsertRole(connection, group, now);
}

export async function createUser(
  connection: DatabaseConnection,
  input: UserMutation,
  actor: AuthenticatedActor
) {
  const phone = normalizeMobilePhone(input.phone);
  const name = nonEmptyName(input.name);
  await assertPhoneAvailable(connection, phone);
  const group = await readEnabledGroup(connection, input.groupId);
  const now = new Date();
  await ensureGroupRole(connection, group, now);
  const personId = `person-${randomUUID()}`;
  const accountId = `account-${personId}`;
  await execute(
    connection,
    `INSERT INTO people (
       id, name, phone, role, group_id, group_name_snapshot, group_locked,
       name_conflict, booth_scope, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      personId,
      name,
      phone,
      roleForGroup(group),
      group.id,
      group.name,
      input.groupLocked,
      null,
      null,
      input.enabled,
      now,
      now
    ]
  );
  await execute(
    connection,
    `INSERT INTO accounts (
       id, person_id, login_name, enabled, auth_version,
       last_login_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [accountId, personId, phone, input.enabled, 1, null, now, now]
  );
  await synchronizeAccountRole(connection, accountId, group.id, now);
  await writeAudit(
    connection,
    "user.create",
    "user",
    personId,
    {
      accountId,
      name,
      phone,
      groupId: group.id,
      groupLocked: input.groupLocked,
      enabled: input.enabled
    },
    actor,
    now
  );
  const user = await getUser(connection, personId);
  if (!user) throw new Error("Created user could not be loaded");
  return user;
}

async function accountPersonForUpdate(
  connection: DatabaseConnection,
  userId: string
) {
  const [record] = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       a.login_name,
       a.enabled AS account_enabled,
       p.id AS person_id,
       p.name AS person_name,
       p.phone,
       p.role,
       p.group_id,
       p.group_name_snapshot,
       p.group_locked,
       p.enabled AS person_enabled,
       g.enabled AS group_enabled
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     LEFT JOIN user_groups g ON g.id = p.group_id
     WHERE a.id = ? OR p.id = ?
     LIMIT 1
     FOR UPDATE`,
    [userId, userId]
  );
  if (!record) throw new Error("User was not found");
  return record;
}

export async function updateUser(
  connection: DatabaseConnection,
  userId: string,
  input: Partial<UserMutation>,
  actor: AuthenticatedActor
) {
  const current = await accountPersonForUpdate(connection, userId);
  const accountId = String(current.account_id);
  const personId = String(current.person_id);
  const currentLoginName = String(current.login_name);
  const currentName = String(current.person_name);
  const currentPhone = String(current.phone);
  const currentRole = String(current.role) as PersonRole;
  const currentGroupId = String(current.group_id ?? "");
  const currentGroupName = String(current.group_name_snapshot ?? "");
  const currentGroupLocked = bool(current.group_locked);
  const currentPersonEnabled = bool(current.person_enabled);
  const currentAccountEnabled = bool(current.account_enabled);
  const currentEnabled = currentPersonEnabled && currentAccountEnabled;
  const nextPhone = input.phone === undefined
    ? currentPhone
    : normalizeMobilePhone(input.phone);
  const nextLoginName = input.phone === undefined
    ? currentLoginName
    : nextPhone;
  const phoneChanged = input.phone !== undefined && (
    nextPhone !== currentPhone ||
    nextLoginName !== currentLoginName
  );
  if (phoneChanged) {
    await assertPhoneAvailable(connection, nextPhone, {
      personId,
      accountId
    });
  }
  const groupChanged =
    input.groupId !== undefined &&
    input.groupId !== currentGroupId;
  const group = groupChanged
    ? await readEnabledGroup(connection, input.groupId as string)
    : undefined;
  if (
    input.enabled === true &&
    !groupChanged &&
    !bool(current.group_enabled)
  ) {
    throw new Error("User group is disabled or missing");
  }
  const nextGroupId = group?.id ?? currentGroupId;
  const nextRole = group ? roleForGroup(group) : currentRole;
  const nextGroupName = group?.name ?? currentGroupName;
  const nextName = input.name === undefined
    ? currentName
    : nonEmptyName(input.name);
  const nextPersonEnabled = input.enabled ?? currentPersonEnabled;
  const nextAccountEnabled = input.enabled ?? currentAccountEnabled;
  const nextEnabled = nextPersonEnabled && nextAccountEnabled;
  const nextGroupLocked = input.groupLocked ?? currentGroupLocked;
  const enabledChanged = input.enabled !== undefined && (
    currentPersonEnabled !== input.enabled ||
    currentAccountEnabled !== input.enabled
  );
  const invalidate =
    phoneChanged ||
    groupChanged ||
    enabledChanged;
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (nextName !== currentName) {
    changes.name = { from: currentName, to: nextName };
  }
  if (phoneChanged) {
    changes.phone = { from: currentPhone, to: nextPhone };
  }
  if (groupChanged) {
    changes.groupId = { from: currentGroupId, to: nextGroupId };
  }
  if (nextGroupLocked !== currentGroupLocked) {
    changes.groupLocked = {
      from: currentGroupLocked,
      to: nextGroupLocked
    };
  }
  if (enabledChanged) {
    changes.enabled = { from: currentEnabled, to: nextEnabled };
  }
  const now = new Date();
  if (group) {
    await ensureGroupRole(connection, group, now);
  }
  await execute(
    connection,
    `UPDATE people
     SET name = ?, phone = ?, role = ?, group_id = ?,
         group_name_snapshot = ?, group_locked = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [
      nextName,
      nextPhone,
      nextRole,
      nextGroupId,
      nextGroupName,
      nextGroupLocked,
      nextPersonEnabled,
      now,
      personId
    ]
  );
  await execute(
    connection,
    `UPDATE accounts
     SET login_name = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [nextLoginName, nextAccountEnabled, now, accountId]
  );
  if (group) {
    await synchronizeAccountRole(connection, accountId, group.id, now);
  }
  if (invalidate) {
    await invalidateAccount(connection, accountId, now);
  }
  await writeAudit(
    connection,
    "user.update",
    "user",
    personId,
    {
      accountId,
      changes,
      authInvalidated: invalidate
    },
    actor,
    now
  );
  const user = await getUser(connection, personId);
  if (!user) throw new Error("Updated user could not be loaded");
  return user;
}

export async function setUserEnabled(
  connection: DatabaseConnection,
  userId: string,
  enabled: boolean,
  actor: AuthenticatedActor
) {
  return await updateUser(connection, userId, { enabled }, actor);
}

export async function deleteUser(
  connection: DatabaseConnection,
  userId: string,
  actor: AuthenticatedActor
) {
  const current = await accountPersonForUpdate(connection, userId);
  const accountId = String(current.account_id);
  const personId = String(current.person_id);
  const now = new Date();
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL
     WHERE person_id = ?`,
    [personId]
  );
  await execute(
    connection,
    "DELETE FROM account_sessions WHERE account_id = ?",
    [accountId]
  );
  await execute(
    connection,
    "DELETE FROM account_credentials WHERE account_id = ?",
    [accountId]
  );
  await execute(
    connection,
    "DELETE FROM account_roles WHERE account_id = ?",
    [accountId]
  );
  await execute(connection, "DELETE FROM accounts WHERE id = ?", [accountId]);
  await execute(connection, "DELETE FROM people WHERE id = ?", [personId]);
  await writeAudit(
    connection,
    "user.delete",
    "user",
    personId,
    {
      accountId,
      phone: String(current.phone),
      groupId: String(current.group_id ?? "")
    },
    actor,
    now
  );
}

export async function setUserPassword(
  connection: DatabaseConnection,
  userId: string,
  passwordHash: string,
  actor: AuthenticatedActor
) {
  if (!passwordHash.trim()) throw new Error("Password hash is required");
  const [account] = await rows<Row>(
    connection,
    `SELECT id, person_id
     FROM accounts
     WHERE id = ? OR person_id = ?
     LIMIT 1`,
    [userId, userId]
  );
  if (!account) throw new Error("User was not found");
  const accountId = String(account.id);
  const personId = String(account.person_id);
  const now = new Date();
  await execute(
    connection,
    `INSERT INTO account_credentials (
       account_id, password_hash, password_changed_at, must_change_password,
       failed_attempts, locked_until
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       password_changed_at = VALUES(password_changed_at),
       must_change_password = false,
       failed_attempts = 0,
       locked_until = NULL`,
    [accountId, passwordHash, now, false, 0, null]
  );
  await invalidateAccount(connection, accountId, now);
  await writeAudit(
    connection,
    "user.password.set",
    "user",
    personId,
    {
      accountId,
      passwordChanged: true
    },
    actor,
    now
  );
}

export async function recordAccessRolesSync(
  connection: DatabaseConnection,
  groups: UserGroup[],
  actor?: AuthenticatedActor
) {
  await writeAudit(
    connection,
    "access.roles.sync",
    "user_groups",
    undefined,
    { groupIds: groups.map((group) => group.id) },
    actor
  );
}
