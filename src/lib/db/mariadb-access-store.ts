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
import type { ChatIdentity, ChatIdentityRebindExpectation, MessageChannel, PersonRole, UserGroup } from "../domain/types";
import type {
  PersistedUserImportPreview,
  UserImportCommitInput,
  UserImportCommitResult,
  UserImportConflictCode,
  UserImportDecisionPatch,
  UserImportPreview,
  UserImportPreviewRow,
  UserImportReportRow
} from "../domain/user-import";
import {
  STALE_IMPORT_MESSAGE,
  assertValidUserImportDecision,
  summarizeUserImportRows
} from "../domain/user-import";
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

function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function json(value: unknown) {
  return JSON.stringify(value ?? null);
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

function chatIdentityFromRow(row: Row): ChatIdentity {
  return {
    id: String(row.id),
    platform: String(row.platform) as MessageChannel,
    externalUserId: String(row.external_user_id),
    displayName: String(row.display_name),
    isTemporary: bool(row.is_temporary),
    personId: row.person_id ? String(row.person_id) : undefined,
    verifiedBy: row.verified_by
      ? String(row.verified_by) as ChatIdentity["verifiedBy"]
      : undefined,
    verifiedAt: iso(row.verified_at),
    firstSeenAt: requiredIso(row.first_seen_at),
    lastSeenAt: requiredIso(row.last_seen_at)
  };
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

export async function countUsableAdmins(
  connection: DatabaseConnection,
  excludeUserId?: string
) {
  if (!excludeUserId) return await usableAdminCount(connection);
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
       AND p.enabled = true
       AND a.id <> ?
       AND p.id <> ?`,
    [excludeUserId, excludeUserId]
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

async function assertMutationKeepsLastAdmin(
  connection: DatabaseConnection,
  accountId: string,
  personId: string,
  input: Partial<UserMutation>,
  nextGroup?: UserGroup,
  currentEnabled = true
) {
  if (!currentEnabled) return;
  const nextEnabled = input.enabled ?? currentEnabled;
  const nextPermissions = nextGroup
    ? permissionCodesForGroup(nextGroup)
    : undefined;
  if (
    nextEnabled &&
    (!nextPermissions || nextPermissions.includes("admin.access"))
  ) {
    return;
  }
  if (await removingTargetAdminWouldLeaveNone(connection, accountId)) {
    throw new Error("At least one usable admin account is required");
  }
}

async function lockUsableAdminRows(connection: DatabaseConnection) {
  const [result] = await connection.execute<Row[]>(
    `SELECT /* usable_admin_lock */
       a.id AS account_id,
       p.id AS person_id
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
       AND p.enabled = true
     GROUP BY a.id, p.id
     ORDER BY a.id
     FOR UPDATE`
  );
  return Array.isArray(result) ? result : [];
}

async function removingTargetAdminWouldLeaveNone(
  connection: DatabaseConnection,
  accountId: string
) {
  const admins = await lockUsableAdminRows(connection);
  if (!admins.some((admin) => String(admin.account_id) === accountId)) {
    return false;
  }
  return admins.length <= 1;
}

async function userDeletionHistoryForAccount(
  connection: DatabaseConnection,
  personId: string,
  accountId: string
) {
  const historyRows = await rows<Row>(
    connection,
    `SELECT reason
     FROM (
       SELECT 'tickets.reporter_person_id' AS reason
       WHERE EXISTS (
         SELECT 1 FROM tickets
         WHERE reporter_person_id = ?
       )
       UNION ALL
       SELECT 'inbound_messages.reporter_person_id' AS reason
       WHERE EXISTS (
         SELECT 1 FROM inbound_messages
         WHERE reporter_person_id = ?
       )
       UNION ALL
       SELECT 'pending_work_order_sessions.person_id' AS reason
       WHERE EXISTS (
         SELECT 1 FROM pending_work_order_sessions
         WHERE person_id = ?
       )
       UNION ALL
       SELECT 'chat_identity_references' AS reason
       WHERE EXISTS (
         SELECT 1
         FROM chat_identities ci
         WHERE ci.person_id = ?
           AND (
             EXISTS (
               SELECT 1 FROM tickets t
               WHERE t.reporter_chat_identity_id = ci.id
             )
             OR EXISTS (
               SELECT 1 FROM inbound_messages im
               WHERE im.reporter_chat_identity_id = ci.id
             )
             OR EXISTS (
               SELECT 1 FROM pending_work_order_sessions ps
               WHERE ps.chat_identity_id = ci.id
             )
             OR EXISTS (
               SELECT 1 FROM outbound_messages om
               WHERE om.target_chat_identity_id = ci.id
             )
           )
       )
       UNION ALL
       SELECT 'conversation_people.person_id' AS reason
       WHERE EXISTS (
         SELECT 1 FROM conversation_people
         WHERE person_id = ?
       )
       UNION ALL
       SELECT 'audit_logs.actor_id' AS reason
       WHERE EXISTS (
         SELECT 1 FROM audit_logs
         WHERE actor_id = ?
       )
     ) deletion_history
     ORDER BY reason`,
    [personId, personId, personId, personId, personId, accountId]
  );
  const reasons = historyRows.map((row) => String(row.reason));
  return {
    hasHistory: reasons.length > 0,
    reasons
  };
}

export async function userDeletionHistory(
  connection: DatabaseConnection,
  userId: string
) {
  const [record] = await rows<Row>(
    connection,
    `SELECT a.id AS account_id, p.id AS person_id
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     WHERE a.id = ? OR p.id = ?
     LIMIT 1`,
    [userId, userId]
  );
  if (!record) return { hasHistory: false, reasons: [] };
  return await userDeletionHistoryForAccount(
    connection,
    String(record.person_id),
    String(record.account_id)
  );
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
  await assertMutationKeepsLastAdmin(
    connection,
    accountId,
    personId,
    input,
    group,
    currentEnabled
  );
  const enabledChanged = input.enabled !== undefined && (
    currentPersonEnabled !== input.enabled ||
    currentAccountEnabled !== input.enabled
  );
  const groupLockedChanged = nextGroupLocked !== currentGroupLocked;
  const invalidate =
    phoneChanged ||
    groupChanged ||
    enabledChanged ||
    groupLockedChanged;
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
  if (groupLockedChanged) {
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
  if (await removingTargetAdminWouldLeaveNone(connection, accountId)) {
    throw new Error("At least one usable admin account is required");
  }
  const history = await userDeletionHistoryForAccount(
    connection,
    personId,
    accountId
  );
  if (history.hasHistory) {
    throw new Error("User has business history and cannot be deleted");
  }
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

export async function listChatIdentities(
  connection: DatabaseConnection,
  query: { platform?: MessageChannel; stableOnly?: boolean }
) {
  const clauses: string[] = [];
  const params: SqlValue[] = [];
  if (query.platform) {
    clauses.push("platform = ?");
    params.push(query.platform);
  }
  if (query.stableOnly) {
    clauses.push("is_temporary = false");
  }
  const identityRows = await rows<Row>(
    connection,
    `SELECT *
     FROM chat_identities
     ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
     ORDER BY last_seen_at DESC, display_name, id`,
    params
  );
  return identityRows.map(chatIdentityFromRow);
}

export async function identityByExternalId(
  connection: DatabaseConnection,
  platform: MessageChannel,
  externalUserId: string
) {
  const [identity] = await rows<Row>(
    connection,
    `SELECT *
     FROM chat_identities
     WHERE platform = ? AND external_user_id = ?
     LIMIT 1`,
    [platform, externalUserId]
  );
  return identity ? chatIdentityFromRow(identity) : undefined;
}

async function userPersonForIdentityMutation(
  connection: DatabaseConnection,
  userId: string
) {
  const [record] = await rows<Row>(
    connection,
    `SELECT p.id AS person_id
     FROM people p
     JOIN accounts a ON a.person_id = p.id
     WHERE p.id = ? OR a.id = ?
     LIMIT 1
     FOR UPDATE`,
    [userId, userId]
  );
  if (!record) throw new Error("User was not found");
  return String(record.person_id);
}

async function lockedIdentityByExternalId(
  connection: DatabaseConnection,
  platform: MessageChannel,
  externalUserId: string
) {
  const [identity] = await rows<Row>(
    connection,
    `SELECT *
     FROM chat_identities
     WHERE platform = ? AND external_user_id = ?
     LIMIT 1
     FOR UPDATE`,
    [platform, externalUserId]
  );
  return identity;
}

function assertExpectedChatIdentityRebind(
  expected: ChatIdentityRebindExpectation | undefined,
  actual: ChatIdentityRebindExpectation
) {
  if (
    !expected ||
    expected.platform !== actual.platform ||
    expected.identityId !== actual.identityId ||
    expected.fromPersonId !== actual.fromPersonId ||
    expected.toPersonId !== actual.toPersonId
  ) {
    throw new Error("Chat identity binding changed; retry confirmation");
  }
}

export async function bindChatIdentity(
  connection: DatabaseConnection,
  input: {
    userId: string;
    platform: MessageChannel;
    externalUserId: string;
    displayName?: string;
    confirmedRebind?: boolean;
    expectedRebind?: ChatIdentityRebindExpectation;
  },
  actor: AuthenticatedActor
) {
  const personId = await userPersonForIdentityMutation(connection, input.userId);
  const now = new Date();
  let identity = await lockedIdentityByExternalId(
    connection,
    input.platform,
    input.externalUserId
  );
  if (!identity) {
    if (input.expectedRebind) {
      throw new Error("Chat identity binding changed; retry confirmation");
    }
    const identityId = `chat-${createHash("sha256")
      .update(`${input.platform}:${input.externalUserId}`)
      .digest("base64url")}`;
    await execute(
      connection,
      `INSERT INTO chat_identities (
         id, platform, external_user_id, display_name, is_temporary,
         person_id, verified_by, verified_at, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        identityId,
        input.platform,
        input.externalUserId,
        input.displayName?.trim() || input.externalUserId,
        false,
        null,
        null,
        null,
        now,
        now
      ]
    );
    identity = await lockedIdentityByExternalId(
      connection,
      input.platform,
      input.externalUserId
    );
  }
  if (!identity) throw new Error("Chat identity was not found");
  if (bool(identity.is_temporary)) {
    throw new Error("Temporary identities cannot be bound by administrators");
  }
  const identityId = String(identity.id);
  const fromPersonId = identity.person_id
    ? String(identity.person_id)
    : undefined;
  if (
    fromPersonId &&
    fromPersonId !== personId
  ) {
    if (!input.confirmedRebind) {
      throw new Error("Chat identity is assigned to another user");
    }
    assertExpectedChatIdentityRebind(input.expectedRebind, {
      platform: String(identity.platform) as MessageChannel,
      identityId,
      fromPersonId,
      toPersonId: personId
    });
  } else if (input.expectedRebind) {
    assertExpectedChatIdentityRebind(input.expectedRebind, {
      platform: String(identity.platform) as MessageChannel,
      identityId,
      fromPersonId: fromPersonId ?? "",
      toPersonId: personId
    });
  }

  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL,
         last_seen_at = ?
     WHERE person_id = ? AND platform = ? AND id <> ?`,
    [now, personId, input.platform, identityId]
  );
  if (fromPersonId && fromPersonId !== personId && input.confirmedRebind) {
    await execute(
      connection,
      `UPDATE chat_identities
       SET person_id = NULL, verified_by = NULL, verified_at = NULL,
           last_seen_at = ?
       WHERE id = ? AND person_id = ?`,
      [now, identityId, fromPersonId]
    );
  }
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = ?, display_name = ?, verified_by = 'admin',
         verified_at = ?, last_seen_at = ?
     WHERE id = ?`,
    [
      personId,
      input.displayName?.trim() || String(identity.display_name),
      now,
      now,
      identityId
    ]
  );
  await writeAudit(
    connection,
    "chat_identity.bind",
    "chat_identity",
    identityId,
    {
      personId,
      platform: input.platform,
      externalUserId: input.externalUserId,
      fromPersonId,
      confirmedRebind: Boolean(input.confirmedRebind)
    },
    actor,
    now
  );
  const rebound = await identityByExternalId(
    connection,
    input.platform,
    input.externalUserId
  );
  if (!rebound) throw new Error("Bound chat identity could not be loaded");
  return rebound;
}

export async function unbindChatIdentity(
  connection: DatabaseConnection,
  input: { userId: string; platform: MessageChannel },
  actor: AuthenticatedActor
) {
  const personId = await userPersonForIdentityMutation(connection, input.userId);
  const identityRows = await rows<Row>(
    connection,
    `SELECT id
     FROM chat_identities
     WHERE person_id = ? AND platform = ?
     FOR UPDATE`,
    [personId, input.platform]
  );
  const identityIds = identityRows.map((row) => String(row.id));
  const now = new Date();
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL,
         last_seen_at = ?
     WHERE person_id = ? AND platform = ?`,
    [now, personId, input.platform]
  );
  await writeAudit(
    connection,
    "chat_identity.unbind",
    "user",
    personId,
    {
      platform: input.platform,
      identityIds
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

function importRowFromDatabase(row: Row): UserImportPreviewRow {
  const raw = parseJsonValue<UserImportPreviewRow["raw"]>(
    row.raw_payload,
    {}
  );
  const value = parseJsonValue<UserImportPreviewRow["value"]>(
    row.normalized_payload,
    undefined
  );
  const conflicts = parseJsonValue<UserImportPreviewRow["conflicts"]>(
    row.conflict_json,
    []
  );
  const decision = parseJsonValue<UserImportPreviewRow["decision"]>(
    row.decision_json,
    undefined
  );
  const metadata = parseJsonValue<{
    allowedActions?: UserImportPreviewRow["allowedActions"];
    category?: UserImportPreviewRow["category"];
    baseline?: UserImportPreviewRow["baseline"];
  }>(
    row.message,
    {}
  );
  const allowedActions = metadata.allowedActions ?? (
    conflicts.length ? ["skip"] : ["add", "skip"]
  );
  const category = metadata.category ?? (
    allowedActions.includes("overwrite")
      ? "overwrite"
      : allowedActions.includes("add")
        ? "add"
        : "blocked"
  );
  return {
    id: String(row.id),
    rowNumber: Number(row.row_number),
    raw,
    ...(value ? { value } : {}),
    conflicts,
    allowedActions,
    category,
    selectable: allowedActions.some((action) => action !== "skip"),
    ...(decision ? { decision } : {}),
    ...(metadata.baseline ? { baseline: metadata.baseline } : {})
  };
}

export async function saveUserImportPreview(
  connection: DatabaseConnection,
  preview: PersistedUserImportPreview
) {
  const now = new Date();
  await execute(
    connection,
    `INSERT INTO import_jobs (
       id, type, source_name, status, total_rows, success_rows, failed_rows,
       owner_account_id, source_hash, preview_version, created_at,
       completed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      preview.jobId,
      "people",
      preview.sourceName,
      "preview",
      preview.rows.length,
      0,
      0,
      preview.ownerAccountId,
      preview.sourceHash,
      preview.previewVersion,
      now,
      null,
      now
    ]
  );
  for (const row of preview.rows) {
    await execute(
      connection,
      `INSERT INTO import_job_rows (
         id, job_id, \`row_number\`, status, message, raw_payload,
         normalized_payload, conflict_json, decision_json, result_action,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        preview.jobId,
        row.rowNumber,
        "preview",
        json({
          allowedActions: row.allowedActions,
          category: row.category,
          ...(row.baseline ? { baseline: row.baseline } : {})
        }),
        json(row.raw),
        row.value ? json(row.value) : null,
        json(row.conflicts),
        null,
        null,
        now,
        now
      ]
    );
  }
}

export async function getUserImportJobRows(
  connection: DatabaseConnection,
  jobId: string,
  actor: AuthenticatedActor
): Promise<UserImportPreview> {
  const [job] = await rows<Row>(
    connection,
    `SELECT *
     FROM import_jobs
     WHERE id = ? AND type = 'people' AND owner_account_id = ?
     LIMIT 1`,
    [jobId, actor.accountId]
  );
  if (!job) throw new Error("User import preview job was not found");
  const rowRecords = await rows<Row>(
    connection,
    `SELECT *
     FROM import_job_rows
     WHERE job_id = ?
     ORDER BY \`row_number\`, id`,
    [jobId]
  );
  const importRows = rowRecords.map(importRowFromDatabase);
  return {
    jobId: String(job.id),
    previewVersion: String(job.preview_version ?? ""),
    sourceName: String(job.source_name),
    sourceHash: String(job.source_hash ?? ""),
    rows: importRows,
    summary: summarizeUserImportRows(importRows)
  };
}

export async function saveUserImportDecisions(
  connection: DatabaseConnection,
  jobId: string,
  decisions: UserImportDecisionPatch[],
  actor: AuthenticatedActor
) {
  const preview = await getUserImportJobRows(connection, jobId, actor);
  const rowById = new Map(preview.rows.map((row) => [row.id, row]));
  const now = new Date();
  for (const patch of decisions) {
    const row = rowById.get(patch.rowId);
    if (!row) throw new Error("User import row was not found");
    const decision = assertValidUserImportDecision(row, patch.decision);
    await execute(
      connection,
      `UPDATE import_job_rows
       SET decision_json = ?, result_action = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      [
        json(decision),
        decision.action,
        now,
        patch.rowId,
        jobId
      ]
    );
  }
  await execute(
    connection,
    "UPDATE import_jobs SET updated_at = ? WHERE id = ?",
    [now, jobId]
  );
}

export async function markUserImportRowsStale(
  connection: DatabaseConnection,
  jobId: string,
  rowIds: string[],
  actor: AuthenticatedActor
) {
  const preview = await getUserImportJobRows(connection, jobId, actor);
  const staleIds = new Set(rowIds);
  const now = new Date();
  for (const row of preview.rows) {
    if (!staleIds.has(row.id)) continue;
    const conflicts = new Set<UserImportConflictCode>(row.conflicts);
    conflicts.add("stale-preview");
    await execute(
      connection,
      `UPDATE import_job_rows
       SET status = ?, message = ?, conflict_json = ?, decision_json = ?,
           result_action = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      [
        "stale",
        json({
          allowedActions: ["skip"],
          category: "blocked",
          ...(row.baseline ? { baseline: row.baseline } : {})
        }),
        json([...conflicts]),
        json({
          action: "skip",
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }),
        "skip",
        now,
        row.id,
        jobId
      ]
    );
  }
  await execute(
    connection,
    "UPDATE import_jobs SET updated_at = ? WHERE id = ?",
    [now, jobId]
  );
}

function expectedImportRebind(
  row: UserImportPreviewRow,
  platform: MessageChannel,
  toPersonId: string
) {
  const baseline = row.baseline?.identities?.[platform];
  const confirmed = platform === "wechat"
    ? row.decision?.confirmWechatRebind
    : row.decision?.confirmWecomRebind;
  if (!baseline || !confirmed) return undefined;
  return {
    platform,
    identityId: baseline.identityId,
    fromPersonId: baseline.personId ?? "",
    toPersonId
  };
}

async function lockedUserImportJobRows(
  connection: DatabaseConnection,
  jobId: string,
  actor: AuthenticatedActor
) {
  const [job] = await rows<Row>(
    connection,
    `SELECT *
     FROM import_jobs
     WHERE id = ? AND type = 'people' AND owner_account_id = ?
     LIMIT 1
     FOR UPDATE`,
    [jobId, actor.accountId]
  );
  if (!job) throw new Error("User import preview job was not found");
  const rowRecords = await rows<Row>(
    connection,
    `SELECT *
     FROM import_job_rows
     WHERE job_id = ?
     ORDER BY \`row_number\`, id
     FOR UPDATE`,
    [jobId]
  );
  return rowRecords.map(importRowFromDatabase);
}

async function lockedUserByPhone(
  connection: DatabaseConnection,
  phone: string,
  baselinePersonId?: string
) {
  const [record] = await rows<Row>(
    connection,
    `SELECT
       p.id AS person_id,
       p.updated_at AS person_updated_at,
       a.updated_at AS account_updated_at
     FROM people p
     JOIN accounts a ON a.person_id = p.id
     WHERE p.phone = ?
        OR a.login_name = ?
        OR (? IS NOT NULL AND p.id = ?)
     ORDER BY
       CASE WHEN p.phone = ? OR a.login_name = ? THEN 0 ELSE 1 END,
       p.id
     LIMIT 1
     FOR UPDATE`,
    [
      phone,
      phone,
      baselinePersonId ?? null,
      baselinePersonId ?? null,
      phone,
      phone
    ]
  );
  if (!record) return undefined;
  const personUpdatedAt = requiredIso(record.person_updated_at);
  const accountUpdatedAt = requiredIso(record.account_updated_at);
  return {
    personId: String(record.person_id),
    updatedAt: personUpdatedAt > accountUpdatedAt
      ? personUpdatedAt
      : accountUpdatedAt
  };
}

async function lockedUserGroup(
  connection: DatabaseConnection,
  groupId: string
) {
  const [group] = await rows<Row>(
    connection,
    `SELECT id, enabled
     FROM user_groups
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [groupId]
  );
  return group
    ? { groupId: String(group.id), enabled: bool(group.enabled) }
    : undefined;
}

async function lockedChatIdentityByExternalId(
  connection: DatabaseConnection,
  platform: MessageChannel,
  externalUserId: string
) {
  const identity = await lockedIdentityByExternalId(
    connection,
    platform,
    externalUserId
  );
  return identity ? chatIdentityFromRow(identity) : undefined;
}

function importIdentityChanged(
  current: ChatIdentity | undefined,
  baseline: NonNullable<NonNullable<UserImportPreviewRow["baseline"]>["identities"]>[MessageChannel] | undefined
) {
  if (!baseline) return Boolean(current?.personId);
  return (
    !current ||
    current.id !== baseline.identityId ||
    current.personId !== baseline.personId ||
    current.lastSeenAt !== baseline.updatedAt
  );
}

function importDecisionConfirmedRebind(
  row: UserImportPreviewRow,
  platform: MessageChannel
) {
  if (!row.decision || row.decision.action === "skip") return false;
  return platform === "wechat"
    ? row.decision.confirmWechatRebind
    : row.decision.confirmWecomRebind;
}

function sameImportDecision(
  first: UserImportPreviewRow["decision"],
  second: UserImportPreviewRow["decision"]
) {
  return (
    first?.action === second?.action &&
    first?.confirmWechatRebind === second?.confirmWechatRebind &&
    first?.confirmWecomRebind === second?.confirmWecomRebind
  );
}

async function userImportRowIsStaleInTransaction(
  connection: DatabaseConnection,
  row: UserImportPreviewRow
) {
  const value = row.value;
  const decision = row.decision;
  if (!value || !decision) return true;
  try {
    assertValidUserImportDecision(row, decision);
  } catch {
    return true;
  }

  const currentUser = await lockedUserByPhone(
    connection,
    value.phone,
    row.baseline?.person?.personId
  );
  if (row.baseline?.person) {
    if (
      !currentUser ||
      currentUser.personId !== row.baseline.person.personId ||
      currentUser.updatedAt !== row.baseline.person.updatedAt
    ) {
      return true;
    }
  }

  const liveActions = currentUser ? ["overwrite", "skip"] : ["add", "skip"];
  if (!liveActions.includes(decision.action)) return true;

  const group = await lockedUserGroup(connection, value.groupId);
  if (
    !group?.enabled ||
    (row.baseline?.group &&
      (
        group.groupId !== row.baseline.group.groupId ||
        group.enabled !== row.baseline.group.enabled
      ))
  ) {
    return true;
  }

  for (const [platform, externalUserId] of [
    ["wechat", value.wechatExternalUserId],
    ["wecom", value.wecomExternalUserId]
  ] as const) {
    if (!externalUserId) continue;
    const baseline = row.baseline?.identities?.[platform];
    const identity = await lockedChatIdentityByExternalId(
      connection,
      platform,
      externalUserId
    );
    if (importIdentityChanged(identity, baseline)) return true;
    if (
      row.conflicts.includes(`${platform}-occupied`) &&
      !importDecisionConfirmedRebind(row, platform)
    ) {
      return true;
    }
    if (
      identity?.personId &&
      currentUser?.personId &&
      identity.personId !== currentUser.personId &&
      !row.conflicts.includes(`${platform}-occupied`)
    ) {
      return true;
    }
  }

  return false;
}

async function markLockedUserImportRowsStale(
  connection: DatabaseConnection,
  jobId: string,
  importRows: UserImportPreviewRow[],
  rowIds: string[]
) {
  const staleIds = new Set(rowIds);
  const now = new Date();
  for (const row of importRows) {
    if (!staleIds.has(row.id)) continue;
    const conflicts = new Set<UserImportConflictCode>(row.conflicts);
    conflicts.add("stale-preview");
    await execute(
      connection,
      `UPDATE import_job_rows
       SET status = ?, message = ?, conflict_json = ?, decision_json = ?,
           result_action = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      [
        "stale",
        json({
          allowedActions: ["skip"],
          category: "blocked",
          ...(row.baseline ? { baseline: row.baseline } : {})
        }),
        json([...conflicts]),
        json({
          action: "skip",
          confirmWechatRebind: false,
          confirmWecomRebind: false
        }),
        "skip",
        now,
        row.id,
        jobId
      ]
    );
  }
  await execute(
    connection,
    "UPDATE import_jobs SET updated_at = ? WHERE id = ?",
    [now, jobId]
  );
}

async function revalidateUserImportRowsInTransaction(
  connection: DatabaseConnection,
  input: UserImportCommitInput,
  actor: AuthenticatedActor
) {
  const lockedRows = await lockedUserImportJobRows(
    connection,
    input.jobId,
    actor
  );
  const lockedById = new Map(lockedRows.map((row) => [row.id, row]));
  const staleRowIds: string[] = [];
  for (const row of input.rows) {
    const lockedRow = lockedById.get(row.id);
    if (
      !lockedRow ||
      !lockedRow.decision ||
      !sameImportDecision(lockedRow.decision, row.decision) ||
      await userImportRowIsStaleInTransaction(connection, lockedRow)
    ) {
      staleRowIds.push(row.id);
    }
  }
  if (staleRowIds.length) {
    await markLockedUserImportRowsStale(
      connection,
      input.jobId,
      lockedRows,
      staleRowIds
    );
    throw new Error(STALE_IMPORT_MESSAGE);
  }
}

export async function applyUserImport(
  connection: DatabaseConnection,
  input: UserImportCommitInput,
  actor: AuthenticatedActor
): Promise<UserImportCommitResult> {
  const now = new Date();
  let committed = 0;
  await revalidateUserImportRowsInTransaction(connection, input, actor);
  for (const row of input.rows) {
    if (!row.value || !row.decision || row.decision.action === "skip") {
      continue;
    }
    const existing = (await listUsers(connection, {
      search: row.value.phone,
      page: 1,
      pageSize: 10
    })).users.find((user) => user.phone === row.value?.phone);
    const mutation = {
      name: row.value.name,
      phone: row.value.phone,
      groupId: row.value.groupId,
      groupLocked: row.value.groupLocked,
      enabled: row.value.enabled
    };
    const user = existing
      ? await updateUser(connection, existing.personId, mutation, actor)
      : await createUser(connection, mutation, actor);
    if (row.value.wechatExternalUserId) {
      await bindChatIdentity(connection, {
        userId: user.personId,
        platform: "wechat",
        externalUserId: row.value.wechatExternalUserId,
        displayName: row.value.name,
        confirmedRebind: row.decision.confirmWechatRebind,
        expectedRebind: expectedImportRebind(row, "wechat", user.personId)
      }, actor);
    }
    if (row.value.wecomExternalUserId) {
      await bindChatIdentity(connection, {
        userId: user.personId,
        platform: "wecom",
        externalUserId: row.value.wecomExternalUserId,
        displayName: row.value.name,
        confirmedRebind: row.decision.confirmWecomRebind,
        expectedRebind: expectedImportRebind(row, "wecom", user.personId)
      }, actor);
    }
    await execute(
      connection,
      `UPDATE import_job_rows
       SET status = ?, result_action = ?, decision_json = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      ["success", row.decision.action, json(row.decision), now, row.id, input.jobId]
    );
    committed += 1;
  }
  await execute(
    connection,
    `UPDATE import_jobs
     SET status = ?, success_rows = ?, failed_rows = ?, completed_at = ?, updated_at = ?
     WHERE id = ?`,
    ["completed", committed, 0, now, now, input.jobId]
  );
  await writeAudit(
    connection,
    "user_import.commit",
    "import_job",
    input.jobId,
    { committed, sourceName: input.sourceName },
    actor,
    now
  );
  return { committed };
}

export async function userImportReport(
  connection: DatabaseConnection,
  jobId: string,
  actor: AuthenticatedActor
): Promise<UserImportReportRow[]> {
  const preview = await getUserImportJobRows(connection, jobId, actor);
  return preview.rows.map((row) => {
    const stale = row.conflicts.includes("stale-preview");
    return {
      rowNumber: row.rowNumber,
      name: row.value?.name ?? Object.values(row.raw)[0] ?? "",
      phone: row.value?.phone ?? "",
      action: stale
        ? "blocked"
        : row.decision?.action ?? (row.selectable ? "" : "blocked"),
      status: stale
        ? "failed"
        : row.decision?.action === "skip"
          ? "skipped"
          : row.decision
            ? "success"
            : row.selectable
              ? "pending"
              : "failed",
      message: stale
        ? row.conflicts.join(", ")
        : row.decision?.action === "skip"
          ? "skipped"
          : row.decision
            ? "imported"
            : row.conflicts.length
              ? row.conflicts.join(", ")
              : "pending"
    };
  });
}
