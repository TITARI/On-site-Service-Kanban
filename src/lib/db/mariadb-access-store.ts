import { randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  AccountCredential,
  AccountSession,
  AdminLoginRecord,
  AuthenticatedActor,
  ChatIdentityBindingMutation,
  ManagedChatIdentity,
  MobileAccountInput,
  PermissionCode,
  SessionResolution,
  SessionType,
  UserDeletionHistory,
  UserListItem,
  UserMutation,
  UserQuery
} from "../domain/access-control";
import { PERMISSION_CODES, permissionCodesForGroup } from "../domain/access-control";
import type { MessageChannel, UserGroup } from "../domain/types";
import type {
  UserImportApplyResult,
  UserImportDecision,
  UserImportJob,
  UserImportRow
} from "../domain/user-import";
import type { AppConfig } from "../seed";
import type { DatabaseConnection } from "./connection";

type Row = RowDataPacket & Record<string, unknown>;
type SqlValue = string | number | boolean | Date | null;

export type BootstrapAdminStoreInput = {
  name: string;
  phone: string;
  passwordHash: string;
  group:
    | { mode: "existing"; groupId: string }
    | { mode: "create"; name: string };
};

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

function parsedJson<T>(value: unknown, fallback: T): T {
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

function iso(value: unknown): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function requiredIso(value: unknown) {
  return iso(value) ?? new Date().toISOString();
}

function normalizePhone(value: string) {
  const phone = value.replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("手机号格式不正确");
  return phone;
}

function normalizedFutureIso(value: string, field = "会话到期时间") {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field}格式不正确`);
  if (timestamp <= Date.now()) throw new Error(`${field}必须晚于当前时间`);
  return new Date(timestamp).toISOString();
}

function roleId(groupId: string) {
  return `role-${groupId}`;
}

function permissionsFromRows(input: Row[]) {
  const granted = new Set(
    input
      .map((row) => row.permission_code)
      .filter((code): code is PermissionCode => (
        typeof code === "string" && PERMISSION_CODES.includes(code as PermissionCode)
      ))
  );
  return PERMISSION_CODES.filter((code) => granted.has(code));
}

function actorFromRows(input: Row[], sessionType: SessionType): AuthenticatedActor | undefined {
  const first = input[0];
  if (!first) return undefined;
  const permissions = permissionsFromRows(input);
  if (sessionType === "admin" && !permissions.includes("admin.access")) return undefined;
  return {
    accountId: String(first.account_id),
    personId: String(first.person_id),
    name: String(first.person_name),
    phone: String(first.person_phone),
    groupId: String(first.group_id),
    groupName: String(first.group_name),
    permissions,
    sessionType
  };
}

async function actorRows(
  connection: DatabaseConnection,
  accountId: string
) {
  return rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       p.id AS person_id,
       p.name AS person_name,
       p.phone AS person_phone,
       p.group_id,
       COALESCE(g.name, p.group_name_snapshot) AS group_name,
       rp.permission_code
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r ON r.id = ar.role_id
     JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE a.id = ?
       AND a.enabled = true
       AND p.enabled = true
       AND g.enabled = true
       AND r.enabled = true
       AND r.source_group_id = p.group_id
     ORDER BY rp.permission_code`,
    [accountId]
  );
}

async function loadActor(
  connection: DatabaseConnection,
  accountId: string,
  sessionType: SessionType
) {
  return actorFromRows(await actorRows(connection, accountId), sessionType);
}

async function appendAudit(
  connection: DatabaseConnection,
  input: {
    actorId?: string;
    actorName?: string;
    action: string;
    targetType: string;
    targetId?: string;
    detail?: Record<string, unknown>;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  await execute(
    connection,
    `INSERT INTO audit_logs (
       id, actor_id, actor_name, action, target_type, target_id, detail_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `audit-${randomUUID()}`,
      input.actorId ?? null,
      input.actorName ?? "system",
      input.action,
      input.targetType,
      input.targetId ?? null,
      JSON.stringify(input.detail ?? {}),
      now
    ]
  );
}

type StoredRole = {
  id: string;
  sourceGroupId: string;
  name: string;
  enabled: boolean;
  permissions: PermissionCode[];
};

async function storedRoles(connection: DatabaseConnection) {
  const roleRows = await rows<Row>(
    connection,
    `SELECT r.id, r.source_group_id, r.name, r.enabled, rp.permission_code
     FROM roles r
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     ORDER BY r.id, rp.permission_code`
  );
  const byId = new Map<string, StoredRole>();
  for (const row of roleRows) {
    const id = String(row.id);
    const role = byId.get(id) ?? {
      id,
      sourceGroupId: String(row.source_group_id),
      name: String(row.name),
      enabled: bool(row.enabled),
      permissions: []
    };
    if (
      typeof row.permission_code === "string"
      && PERMISSION_CODES.includes(row.permission_code as PermissionCode)
    ) {
      role.permissions.push(row.permission_code as PermissionCode);
    }
    byId.set(id, role);
  }
  for (const role of byId.values()) {
    role.permissions = PERMISSION_CODES.filter((code) => role.permissions.includes(code));
  }
  return byId;
}

function samePermissions(left: PermissionCode[], right: PermissionCode[]) {
  return left.length === right.length && left.every((code, index) => code === right[index]);
}

async function invalidateGroups(
  connection: DatabaseConnection,
  groupIds: string[],
  now: Date
) {
  if (groupIds.length === 0) return;
  const placeholders = groupIds.map(() => "?").join(", ");
  await execute(
    connection,
    `UPDATE account_sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN people p ON p.id = a.person_id
     SET s.revoked_at = COALESCE(s.revoked_at, ?)
     WHERE p.group_id IN (${placeholders})
       AND s.revoked_at IS NULL`,
    [now, ...groupIds]
  );
  await execute(
    connection,
    `UPDATE accounts a
     JOIN people p ON p.id = a.person_id
     SET a.auth_version = a.auth_version + 1,
         a.updated_at = ?
     WHERE p.group_id IN (${placeholders})`,
    [now, ...groupIds]
  );
}

export async function syncAccessRoles(
  connection: DatabaseConnection,
  groups: UserGroup[],
  now = new Date()
) {
  const existing = await storedRoles(connection);
  const desiredIds = new Set(groups.map((group) => roleId(group.id)));
  const changedGroups = new Set<string>();

  for (const group of groups) {
    const id = roleId(group.id);
    const permissions = permissionCodesForGroup(group);
    const current = existing.get(id);
    if (
      !current
      || current.sourceGroupId !== group.id
      || current.name !== group.name
      || current.enabled !== group.enabled
      || !samePermissions(current.permissions, permissions)
    ) {
      changedGroups.add(group.id);
    }

    await execute(
      connection,
      `INSERT INTO roles (id, name, source_group_id, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         source_group_id = VALUES(source_group_id),
         enabled = VALUES(enabled),
         updated_at = VALUES(updated_at)`,
      [id, group.name, group.id, group.enabled, now, now]
    );
    await execute(connection, "DELETE FROM role_permissions WHERE role_id = ?", [id]);
    for (const permissionCode of permissions) {
      await execute(
        connection,
        `INSERT INTO role_permissions (role_id, permission_code, created_at)
         VALUES (?, ?, ?)`,
        [id, permissionCode, now]
      );
    }
  }

  for (const role of existing.values()) {
    if (desiredIds.has(role.id)) continue;
    changedGroups.add(role.sourceGroupId);
    await execute(
      connection,
      "UPDATE roles SET enabled = false, updated_at = ? WHERE id = ?",
      [now, role.id]
    );
    await execute(connection, "DELETE FROM role_permissions WHERE role_id = ?", [role.id]);
  }

  await invalidateGroups(connection, [...changedGroups], now);
}

async function enabledGroup(connection: DatabaseConnection, groupId: string, lock = false) {
  const [group] = await rows<Row>(
    connection,
    `SELECT id, name, can_claim, can_process, can_accept, can_admin, enabled
     FROM user_groups
     WHERE id = ? AND enabled = true
     LIMIT 1${lock ? " FOR UPDATE" : ""}`,
    [groupId]
  );
  if (!group) throw new Error("用户分组不存在或已停用");
  return group;
}

function personRole(group: Row) {
  if (bool(group.can_claim) || bool(group.can_process)) return "handler";
  if (bool(group.can_accept) || bool(group.can_admin)) return "manager";
  return "reporter";
}

async function assignAccountRole(
  connection: DatabaseConnection,
  accountId: string,
  groupId: string,
  now: Date
) {
  await execute(connection, "DELETE FROM account_roles WHERE account_id = ?", [accountId]);
  await execute(
    connection,
    "INSERT INTO account_roles (account_id, role_id, created_at) VALUES (?, ?, ?)",
    [accountId, roleId(groupId), now]
  );
}

async function revokeAccountSessionsInternal(
  connection: DatabaseConnection,
  accountId: string,
  now: Date,
  incrementVersion: boolean
) {
  await execute(
    connection,
    `UPDATE account_sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE account_id = ? AND revoked_at IS NULL`,
    [now, accountId]
  );
  if (incrementVersion) {
    await execute(
      connection,
      `UPDATE accounts
       SET auth_version = auth_version + 1, updated_at = ?
       WHERE id = ?`,
      [now, accountId]
    );
  }
}

export async function upsertMobileAccount(
  connection: DatabaseConnection,
  config: AppConfig,
  input: MobileAccountInput
): Promise<{ actor: AuthenticatedActor }> {
  const phone = normalizePhone(input.phone);
  const submittedGroup = await enabledGroup(connection, input.groupId, true);
  const [existing] = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       a.person_id,
       a.enabled AS account_enabled,
       a.auth_version AS account_auth_version,
       p.enabled AS person_enabled,
       p.group_locked,
       p.group_id
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     WHERE a.login_name = ?
     LIMIT 1
     FOR UPDATE`,
    [phone]
  );
  const now = new Date();
  let accountId: string;
  let personId: string;

  if (!existing) {
    personId = `person-${randomUUID()}`;
    accountId = `account-${randomUUID()}`;
    await execute(
      connection,
      `INSERT INTO people (
         id, name, phone, role, group_id, group_name_snapshot, group_locked,
         name_conflict, booth_scope, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        personId,
        input.name.trim(),
        phone,
        personRole(submittedGroup),
        String(submittedGroup.id),
        String(submittedGroup.name),
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
         id, person_id, login_name, enabled, auth_version, last_login_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [accountId, personId, phone, true, 1, now, now, now]
    );
    await assignAccountRole(connection, accountId, String(submittedGroup.id), now);
  } else {
    if (!bool(existing.account_enabled) || !bool(existing.person_enabled)) {
      throw new Error("该账号已停用");
    }
    accountId = String(existing.account_id);
    personId = String(existing.person_id);
    const effectiveGroupId = bool(existing.group_locked)
      ? String(existing.group_id)
      : input.groupId;
    const group = effectiveGroupId === input.groupId
      ? submittedGroup
      : await enabledGroup(connection, effectiveGroupId, true);
    const groupChanged = String(existing.group_id) !== String(group.id);

    await execute(
      connection,
      `UPDATE people
       SET name = ?, phone = ?, role = ?, group_id = ?, group_name_snapshot = ?, updated_at = ?
       WHERE id = ?`,
      [
        input.name.trim(),
        phone,
        personRole(group),
        String(group.id),
        String(group.name),
        now,
        personId
      ]
    );
    await execute(
      connection,
      "UPDATE accounts SET login_name = ?, last_login_at = ?, updated_at = ? WHERE id = ?",
      [phone, now, now, accountId]
    );
    await assignAccountRole(connection, accountId, String(group.id), now);
    if (groupChanged) {
      await revokeAccountSessionsInternal(connection, accountId, now, true);
    }
  }

  const actor = await loadActor(connection, accountId, "mobile");
  if (!actor) throw new Error("账号权限链不可用");
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "mobile.account.upsert",
    targetType: "user",
    targetId: personId,
    detail: { groupId: actor.groupId },
    now
  });
  void config;
  return { actor };
}

export async function createAccountSession(
  connection: DatabaseConnection,
  accountId: string,
  type: SessionType,
  tokenHash: string,
  expiresAt: string
): Promise<AccountSession> {
  const normalizedExpiry = normalizedFutureIso(expiresAt);
  const actor = await loadActor(connection, accountId, type);
  if (!actor) throw new Error("账号无权创建该类型会话");
  const [account] = await rows<Row>(
    connection,
    "SELECT auth_version FROM accounts WHERE id = ? LIMIT 1",
    [accountId]
  );
  if (!account) throw new Error("账号不存在");
  const now = new Date();
  const session: AccountSession = {
    id: `session-${randomUUID()}`,
    accountId,
    sessionType: type,
    tokenHash,
    authVersion: Number(account.auth_version),
    expiresAt: normalizedExpiry,
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
      session.accountId,
      session.sessionType,
      session.tokenHash,
      session.authVersion,
      new Date(session.expiresAt),
      now,
      null,
      now
    ]
  );
  return session;
}

export async function resolveAccountSession(
  connection: DatabaseConnection,
  tokenHash: string,
  type: SessionType
): Promise<SessionResolution | undefined> {
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
       p.phone AS person_phone,
       p.group_id,
       COALESCE(g.name, p.group_name_snapshot) AS group_name,
       rp.permission_code
     FROM account_sessions s
     JOIN accounts a ON a.id = s.account_id
     JOIN people p ON p.id = a.person_id
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r ON r.id = ar.role_id
     JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE s.token_hash = ?
       AND s.session_type = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP(3)
       AND s.auth_version = a.auth_version
       AND a.enabled = true
       AND p.enabled = true
       AND g.enabled = true
       AND r.enabled = true
       AND r.source_group_id = p.group_id
     ORDER BY rp.permission_code`,
    [tokenHash, type]
  );
  const actor = actorFromRows(sessionRows, type);
  const first = sessionRows[0];
  if (!actor || !first) return undefined;
  return {
    actor,
    session: {
      id: String(first.session_id),
      accountId: String(first.account_id),
      sessionType: first.session_type as SessionType,
      tokenHash: String(first.token_hash),
      authVersion: Number(first.session_auth_version),
      expiresAt: requiredIso(first.expires_at),
      lastSeenAt: requiredIso(first.last_seen_at),
      revokedAt: iso(first.revoked_at),
      createdAt: requiredIso(first.session_created_at)
    }
  };
}

export async function revokeAccountSession(
  connection: DatabaseConnection,
  tokenHash: string,
  now = new Date()
) {
  const [session] = await rows<Row>(
    connection,
    `SELECT id, account_id, session_type
     FROM account_sessions
     WHERE token_hash = ? AND revoked_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [tokenHash]
  );
  if (!session) return;
  await execute(
    connection,
    "UPDATE account_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    [now, String(session.id)]
  );
  await appendAudit(connection, {
    action: "session.revoke",
    targetType: "session",
    targetId: String(session.id),
    detail: {
      accountId: String(session.account_id),
      sessionId: String(session.id),
      sessionType: String(session.session_type)
    },
    now
  });
}

export async function revokeAccountSessions(
  connection: DatabaseConnection,
  accountId: string,
  now = new Date()
) {
  const result = await execute(
    connection,
    `UPDATE account_sessions
     SET revoked_at = COALESCE(revoked_at, ?)
     WHERE account_id = ? AND revoked_at IS NULL`,
    [now, accountId]
  );
  await execute(
    connection,
    "UPDATE accounts SET auth_version = auth_version + 1, updated_at = ? WHERE id = ?",
    [now, accountId]
  );
  await appendAudit(connection, {
    action: "sessions.revoke",
    targetType: "account",
    targetId: accountId,
    detail: { accountId, revokedCount: result.affectedRows },
    now
  });
}

export async function adminLoginRecord(
  connection: DatabaseConnection,
  phoneInput: string
): Promise<AdminLoginRecord | undefined> {
  let phone: string;
  try {
    phone = normalizePhone(phoneInput);
  } catch {
    return undefined;
  }
  const loginRows = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       p.id AS person_id,
       p.name AS person_name,
       p.phone AS person_phone,
       p.group_id,
       COALESCE(g.name, p.group_name_snapshot) AS group_name,
       c.password_hash,
       c.password_changed_at,
       c.must_change_password,
       c.failed_attempts,
       c.locked_until,
       rp.permission_code
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN account_credentials c ON c.account_id = a.id
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r ON r.id = ar.role_id
     JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     WHERE a.login_name = ?
       AND a.enabled = true
       AND p.enabled = true
       AND g.enabled = true
       AND r.enabled = true
       AND r.source_group_id = p.group_id
     ORDER BY rp.permission_code`,
    [phone]
  );
  const actor = actorFromRows(loginRows, "admin");
  const first = loginRows[0];
  if (!actor || !first) return undefined;
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
  lockedUntil?: string,
  now = new Date()
) {
  const lockDate = lockedUntil ? new Date(normalizedFutureIso(lockedUntil, "账号锁定到期时间")) : null;
  await execute(
    connection,
    `UPDATE account_credentials
     SET failed_attempts = failed_attempts + 1,
         locked_until = COALESCE(?, locked_until)
     WHERE account_id = ?`,
    [lockDate, accountId]
  );
  await appendAudit(connection, {
    action: "admin.login.failure",
    targetType: "account",
    targetId: accountId,
    detail: { lockedUntil: lockedUntil ?? null },
    now
  });
}

export async function recordAdminLoginSuccess(
  connection: DatabaseConnection,
  accountId: string,
  now = new Date()
) {
  await execute(
    connection,
    "UPDATE account_credentials SET failed_attempts = 0, locked_until = NULL WHERE account_id = ?",
    [accountId]
  );
  await execute(
    connection,
    "UPDATE accounts SET last_login_at = ?, updated_at = ? WHERE id = ?",
    [now, now, accountId]
  );
  await appendAudit(connection, {
    actorId: accountId,
    action: "admin.login.success",
    targetType: "account",
    targetId: accountId,
    now
  });
}

export async function bootstrapStatus(connection: DatabaseConnection) {
  const [state] = await rows<Row>(
    connection,
    "SELECT completed_at FROM auth_bootstrap_state WHERE id = 'admin' LIMIT 1"
  );
  return { required: !state?.completed_at };
}

export async function assertUsableAdminAfterGroupChange(
  connection: DatabaseConnection,
  userGroups: UserGroup[]
) {
  const status = await bootstrapStatus(connection);
  if (status.required) return;

  const adminGroupIds = userGroups
    .filter((group) => group.enabled && group.canAdmin)
    .map((group) => group.id);
  if (adminGroupIds.length === 0) throw new Error("必须保留至少一位可用后台管理员");

  const placeholders = adminGroupIds.map(() => "?").join(", ");
  const [result] = await rows<Row>(
    connection,
    `SELECT COUNT(*) AS usable_admin_count
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN account_credentials c ON c.account_id = a.id
     WHERE a.enabled = true
       AND p.enabled = true
       AND p.group_id IN (${placeholders})`,
    adminGroupIds
  );
  if (Number(result?.usable_admin_count ?? 0) < 1) {
    throw new Error("必须保留至少一位可用后台管理员");
  }
}

function createdAdminGroupId(name: string) {
  return `admin-${Buffer.from(name.trim()).toString("base64url").slice(0, 32) || randomUUID()}`;
}

export async function bootstrapAdmin(
  connection: DatabaseConnection,
  config: AppConfig,
  input: BootstrapAdminStoreInput
): Promise<{ actor: AuthenticatedActor; config: AppConfig }> {
  const [bootstrap] = await rows<Row>(
    connection,
    "SELECT completed_at FROM auth_bootstrap_state WHERE id = 'admin' LIMIT 1 FOR UPDATE"
  );
  if (bootstrap?.completed_at) throw new Error("初始化已完成");

  const groups = [...(config.userGroups ?? [])];
  let group: UserGroup;
  if (input.group.mode === "existing") {
    const existingGroupId = input.group.groupId;
    const index = groups.findIndex((item) => item.id === existingGroupId);
    if (index < 0) throw new Error("管理员分组不存在");
    group = { ...groups[index], enabled: true, canAdmin: true };
    groups[index] = group;
  } else {
    const name = input.group.name.trim();
    if (!name) throw new Error("管理员分组名称不能为空");
    let id = createdAdminGroupId(name);
    while (groups.some((item) => item.id === id)) id = `${id}-${randomUUID().slice(0, 8)}`;
    group = {
      id,
      name,
      description: "系统管理员",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    };
    groups.push(group);
  }
  const nextConfig = { ...config, userGroups: groups };
  const now = new Date();
  await execute(
    connection,
    `INSERT INTO user_groups (
       id, name, description, can_claim, can_process, can_accept, can_admin, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       description = VALUES(description),
       can_claim = VALUES(can_claim),
       can_process = VALUES(can_process),
       can_accept = VALUES(can_accept),
       can_admin = VALUES(can_admin),
       enabled = VALUES(enabled),
       updated_at = VALUES(updated_at)`,
    [
      group.id,
      group.name,
      group.description,
      group.canClaim,
      group.canProcess,
      group.canAccept,
      group.canAdmin,
      group.enabled,
      now,
      now
    ]
  );
  await syncAccessRoles(connection, groups, now);

  const phone = normalizePhone(input.phone);
  const [existing] = await rows<Row>(
    connection,
    `SELECT a.id AS account_id, a.person_id
     FROM accounts a
     WHERE a.login_name = ?
     LIMIT 1
     FOR UPDATE`,
    [phone]
  );
  let accountId: string;
  let personId: string;
  if (existing) {
    accountId = String(existing.account_id);
    personId = String(existing.person_id);
    await execute(
      connection,
      `UPDATE people
       SET name = ?, phone = ?, role = 'manager', group_id = ?, group_name_snapshot = ?,
           group_locked = true, enabled = true, updated_at = ?
       WHERE id = ?`,
      [input.name.trim(), phone, group.id, group.name, now, personId]
    );
    await execute(
      connection,
      `UPDATE accounts
       SET login_name = ?, enabled = true, auth_version = auth_version + 1, updated_at = ?
       WHERE id = ?`,
      [phone, now, accountId]
    );
    await revokeAccountSessionsInternal(connection, accountId, now, false);
  } else {
    accountId = `account-${randomUUID()}`;
    personId = `person-${randomUUID()}`;
    await execute(
      connection,
      `INSERT INTO people (
         id, name, phone, role, group_id, group_name_snapshot, group_locked,
         name_conflict, booth_scope, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, 'manager', ?, ?, true, NULL, NULL, true, ?, ?)`,
      [personId, input.name.trim(), phone, group.id, group.name, now, now]
    );
    await execute(
      connection,
      `INSERT INTO accounts (
         id, person_id, login_name, enabled, auth_version, last_login_at, created_at, updated_at
       ) VALUES (?, ?, ?, true, 1, NULL, ?, ?)`,
      [accountId, personId, phone, now, now]
    );
  }
  await assignAccountRole(connection, accountId, group.id, now);
  await execute(
    connection,
    `INSERT INTO account_credentials (
       account_id, password_hash, password_changed_at, must_change_password, failed_attempts, locked_until
     ) VALUES (?, ?, ?, false, 0, NULL)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       password_changed_at = VALUES(password_changed_at),
       must_change_password = false,
       failed_attempts = 0,
       locked_until = NULL`,
    [accountId, input.passwordHash, now]
  );
  await execute(
    connection,
    `INSERT INTO auth_bootstrap_state (id, completed_at, completed_by_account_id)
     VALUES ('admin', ?, ?)
     ON DUPLICATE KEY UPDATE
       completed_at = VALUES(completed_at),
       completed_by_account_id = VALUES(completed_by_account_id)`,
    [now, accountId]
  );
  const actor = await loadActor(connection, accountId, "admin");
  if (!actor) throw new Error("管理员权限链不可用");
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "admin.bootstrap",
    targetType: "account",
    targetId: accountId,
    detail: { groupId: group.id },
    now
  });
  return { actor, config: nextConfig };
}

function permissionCodes(value: unknown) {
  const values = String(value ?? "")
    .split(",")
    .filter((code): code is PermissionCode => PERMISSION_CODES.includes(code as PermissionCode));
  return PERMISSION_CODES.filter((code) => values.includes(code));
}

async function userRows(
  connection: DatabaseConnection,
  where: string,
  params: SqlValue[],
  limit?: number,
  offset?: number
) {
  const pagination = limit === undefined ? "" : " LIMIT ? OFFSET ?";
  return rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       a.last_login_at,
       a.updated_at AS account_updated_at,
       p.id AS person_id,
       p.name,
       p.phone,
       p.group_id,
       COALESCE(g.name, p.group_name_snapshot) AS group_name,
       p.group_locked,
       p.enabled AS person_enabled,
       a.enabled AS account_enabled,
       p.updated_at AS person_updated_at,
       GROUP_CONCAT(DISTINCT rp.permission_code ORDER BY rp.permission_code SEPARATOR ',') AS permission_codes,
       MAX(CASE WHEN c.account_id IS NULL THEN 0 ELSE 1 END) AS has_password
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     LEFT JOIN user_groups g ON g.id = p.group_id
     LEFT JOIN account_roles ar ON ar.account_id = a.id
     LEFT JOIN roles r ON r.id = ar.role_id AND r.source_group_id = p.group_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN account_credentials c ON c.account_id = a.id
     WHERE ${where}
     GROUP BY
       a.id, a.last_login_at, a.updated_at,
       p.id, p.name, p.phone, p.group_id, g.name, p.group_name_snapshot,
       p.group_locked, p.enabled, a.enabled, p.updated_at
     ORDER BY p.name, p.id${pagination}`,
    limit === undefined ? params : [...params, limit, offset ?? 0]
  );
}

async function identitiesForPeople(
  connection: DatabaseConnection,
  personIds: string[]
) {
  if (personIds.length === 0) return new Map<string, UserListItem["identities"]>();
  const identityRows = await rows<Row>(
    connection,
    `SELECT id, person_id, platform, external_user_id, display_name
     FROM chat_identities
     WHERE person_id IN (${personIds.map(() => "?").join(", ")})
     ORDER BY last_seen_at DESC`,
    personIds
  );
  const result = new Map<string, UserListItem["identities"]>();
  for (const row of identityRows) {
    const personId = String(row.person_id);
    const identities = result.get(personId) ?? {};
    const platform = row.platform as MessageChannel;
    if (!identities[platform]) {
      identities[platform] = {
        id: String(row.id),
        externalUserId: String(row.external_user_id),
        displayName: String(row.display_name)
      };
    }
    result.set(personId, identities);
  }
  return result;
}

async function userItems(connection: DatabaseConnection, inputRows: Row[]) {
  const identities = await identitiesForPeople(
    connection,
    inputRows.map((row) => String(row.person_id))
  );
  return inputRows.map((row): UserListItem => ({
    personId: String(row.person_id),
    accountId: String(row.account_id),
    name: String(row.name),
    phone: String(row.phone),
    groupId: String(row.group_id ?? ""),
    groupName: String(row.group_name ?? ""),
    groupLocked: bool(row.group_locked),
    enabled: bool(row.person_enabled) && bool(row.account_enabled),
    permissions: permissionCodes(row.permission_codes),
    hasPassword: bool(row.has_password),
    lastLoginAt: iso(row.last_login_at),
    identities: identities.get(String(row.person_id)) ?? {},
    updatedAt: [requiredIso(row.person_updated_at), requiredIso(row.account_updated_at)].sort().at(-1)!
  }));
}

function userWhere(query: UserQuery) {
  const conditions = ["1 = 1"];
  const params: SqlValue[] = [];
  if (query.search?.trim()) {
    const search = `%${query.search.trim()}%`;
    conditions.push(`(
      p.name LIKE ?
      OR p.phone LIKE ?
      OR COALESCE(g.name, p.group_name_snapshot) LIKE ?
      OR EXISTS (
        SELECT 1 FROM chat_identities ci_search
        WHERE ci_search.person_id = p.id
          AND (ci_search.external_user_id LIKE ? OR ci_search.display_name LIKE ?)
      )
    )`);
    params.push(search, search, search, search, search);
  }
  if (query.groupId !== undefined) {
    conditions.push("p.group_id = ?");
    params.push(query.groupId);
  }
  if (query.enabled !== undefined) {
    conditions.push(query.enabled
      ? "p.enabled = true AND a.enabled = true"
      : "(p.enabled = false OR a.enabled = false)");
  }
  if (query.admin !== undefined) {
    conditions.push(query.admin
      ? `EXISTS (
          SELECT 1 FROM account_roles ar2
          JOIN roles r2 ON r2.id = ar2.role_id AND r2.source_group_id = p.group_id
          JOIN role_permissions rp2 ON rp2.role_id = r2.id
          WHERE ar2.account_id = a.id AND rp2.permission_code = 'admin.access'
        )`
      : `NOT EXISTS (
          SELECT 1 FROM account_roles ar2
          JOIN roles r2 ON r2.id = ar2.role_id AND r2.source_group_id = p.group_id
          JOIN role_permissions rp2 ON rp2.role_id = r2.id
          WHERE ar2.account_id = a.id AND rp2.permission_code = 'admin.access'
        )`);
  }
  if (query.binding !== undefined) {
    conditions.push(`${query.binding === "bound" ? "" : "NOT "}EXISTS (
      SELECT 1 FROM chat_identities ci WHERE ci.person_id = p.id
    )`);
  }
  return { where: conditions.join(" AND "), params };
}

export async function listUsers(
  connection: DatabaseConnection,
  query: UserQuery
) {
  const { where, params } = userWhere(query);
  const [count] = await rows<Row>(
    connection,
    `SELECT COUNT(*) AS total
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     LEFT JOIN user_groups g ON g.id = p.group_id
     WHERE ${where}`,
    params
  );
  const page = Math.max(1, Math.trunc(query.page));
  const pageSize = Math.min(200, Math.max(1, Math.trunc(query.pageSize)));
  const selected = await userRows(connection, where, params, pageSize, (page - 1) * pageSize);
  return {
    users: await userItems(connection, selected),
    total: Number(count?.total ?? 0)
  };
}

export async function getUser(
  connection: DatabaseConnection,
  userId: string
) {
  const selected = await userRows(
    connection,
    "(p.id = ? OR a.id = ?)",
    [userId, userId]
  );
  return (await userItems(connection, selected))[0];
}

function managedIdentityFromRow(row: Row): ManagedChatIdentity {
  return {
    id: String(row.id),
    platform: row.platform as MessageChannel,
    externalUserId: String(row.external_user_id),
    displayName: String(row.display_name),
    isTemporary: bool(row.is_temporary),
    personId: row.person_id ? String(row.person_id) : undefined,
    personName: row.person_name ? String(row.person_name) : undefined,
    personPhone: row.person_phone ? String(row.person_phone) : undefined,
    firstSeenAt: requiredIso(row.first_seen_at),
    lastSeenAt: requiredIso(row.last_seen_at)
  };
}

const managedIdentitySelect = `SELECT
  ci.id,
  ci.platform,
  ci.external_user_id,
  ci.display_name,
  ci.is_temporary,
  ci.person_id,
  ci.first_seen_at,
  ci.last_seen_at,
  p.name AS person_name,
  p.phone AS person_phone
FROM chat_identities ci
LEFT JOIN people p ON p.id = ci.person_id`;

export async function listChatIdentities(
  connection: DatabaseConnection,
  platform?: MessageChannel
) {
  const selected = await rows<Row>(
    connection,
    `${managedIdentitySelect}
     ${platform ? "WHERE ci.platform = ?" : ""}
     ORDER BY ci.last_seen_at DESC, ci.id`,
    platform ? [platform] : []
  );
  return selected.map(managedIdentityFromRow);
}

export async function getChatIdentity(
  connection: DatabaseConnection,
  identityId: string
) {
  const [selected] = await rows<Row>(
    connection,
    `${managedIdentitySelect}
     WHERE ci.id = ?
     LIMIT 1`,
    [identityId]
  );
  return selected ? managedIdentityFromRow(selected) : undefined;
}

export async function identityByExternalId(
  connection: DatabaseConnection,
  platform: MessageChannel,
  externalUserId: string
) {
  const [selected] = await rows<Row>(
    connection,
    `${managedIdentitySelect}
     WHERE ci.platform = ? AND ci.external_user_id = ?
     LIMIT 1`,
    [platform, externalUserId]
  );
  return selected ? managedIdentityFromRow(selected) : undefined;
}

export async function bindChatIdentity(
  connection: DatabaseConnection,
  input: ChatIdentityBindingMutation,
  actor: AuthenticatedActor
) {
  const target = await lockedUser(connection, input.userId);
  const personId = String(target.person_id);
  const externalUserId = input.externalUserId.trim();
  const displayName = input.displayName.trim() || externalUserId;
  const identityParams = input.identityId
    ? [input.identityId]
    : [input.platform, externalUserId];
  const [selected] = await rows<Row>(
    connection,
    `SELECT *
     FROM chat_identities
     WHERE ${input.identityId ? "id = ?" : "platform = ? AND external_user_id = ?"}
     LIMIT 1
     FOR UPDATE`,
    identityParams
  );
  if (input.identityId && !selected) throw new Error("账号身份不存在");
  if (selected && String(selected.platform) !== input.platform) throw new Error("账号身份平台不匹配");
  if (selected && bool(selected.is_temporary)) throw new Error("临时身份不能绑定，请等待稳定账号标识");

  const identityId = selected ? String(selected.id) : `identity-${randomUUID()}`;
  const fromPersonId = selected?.person_id ? String(selected.person_id) : undefined;
  if (
    fromPersonId
    && fromPersonId !== personId
    && input.confirmedRebindFromPersonId !== fromPersonId
  ) {
    throw new Error("账号身份已被其他用户占用");
  }

  const now = new Date();
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL
     WHERE person_id = ? AND platform = ? AND id <> ?`,
    [personId, input.platform, identityId]
  );

  if (selected) {
    await execute(
      connection,
      `UPDATE chat_identities
       SET person_id = ?, display_name = ?, is_temporary = false,
           verified_by = 'admin', verified_at = ?, last_seen_at = ?
       WHERE id = ?`,
      [personId, displayName, now, now, identityId]
    );
  } else {
    await execute(
      connection,
      `INSERT INTO chat_identities (
         id, platform, external_user_id, display_name, is_temporary,
         person_id, verified_by, verified_at, first_seen_at, last_seen_at
       ) VALUES (?, ?, ?, ?, false, ?, 'admin', ?, ?, ?)`,
      [identityId, input.platform, externalUserId, displayName, personId, now, now, now]
    );
  }

  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: fromPersonId && fromPersonId !== personId
      ? "chat_identity.rebind"
      : "chat_identity.bind",
    targetType: "chat_identity",
    targetId: identityId,
    detail: {
      platform: input.platform,
      externalUserId,
      fromPersonId,
      toPersonId: personId
    },
    now
  });
  const user = await getUser(connection, personId);
  if (!user) throw new Error("用户绑定结果不可用");
  return user;
}

export async function unbindChatIdentity(
  connection: DatabaseConnection,
  userId: string,
  platform: MessageChannel,
  actor: AuthenticatedActor
) {
  const target = await lockedUser(connection, userId);
  const personId = String(target.person_id);
  const identities = await rows<Row>(
    connection,
    `SELECT id, external_user_id
     FROM chat_identities
     WHERE person_id = ? AND platform = ?
     FOR UPDATE`,
    [personId, platform]
  );
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL
     WHERE person_id = ? AND platform = ?`,
    [personId, platform]
  );
  for (const identity of identities) {
    await appendAudit(connection, {
      actorId: actor.accountId,
      actorName: actor.name,
      action: "chat_identity.unbind",
      targetType: "chat_identity",
      targetId: String(identity.id),
      detail: {
        platform,
        externalUserId: String(identity.external_user_id),
        fromPersonId: personId
      }
    });
  }
  const user = await getUser(connection, personId);
  if (!user) throw new Error("用户解绑结果不可用");
  return user;
}

export async function saveUserImportPreview(
  connection: DatabaseConnection,
  job: UserImportJob
) {
  const createdAt = new Date(job.createdAt);
  const updatedAt = new Date(job.updatedAt);
  await execute(
    connection,
    `INSERT INTO import_jobs (
       id, type, source_name, status, total_rows, success_rows, failed_rows,
       owner_account_id, source_hash, preview_version, created_at, updated_at, completed_at
     ) VALUES (?, 'people', ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, NULL)`,
    [
      job.id,
      job.sourceName,
      job.status,
      job.rows.length,
      job.ownerAccountId,
      job.sourceHash,
      job.previewVersion,
      createdAt,
      updatedAt
    ]
  );
  for (const row of job.rows) {
    await execute(
      connection,
      `INSERT INTO import_job_rows (
         id, job_id, \`row_number\`, status, message, raw_payload,
         normalized_payload, conflict_json, decision_json, result_action,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'preview', NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
      [
        row.id,
        job.id,
        row.rowNumber,
        JSON.stringify(row.raw),
        JSON.stringify(row.normalized),
        JSON.stringify({
          errors: row.errors,
          conflicts: row.conflicts,
          allowedActions: row.allowedActions,
          snapshot: row.snapshot
        }),
        createdAt,
        updatedAt
      ]
    );
  }
  return job;
}

export async function loadUserImportJob(
  connection: DatabaseConnection,
  jobId: string
) {
  const [jobRow] = await rows<Row>(
    connection,
    `SELECT *
     FROM import_jobs
     WHERE id = ? AND type = 'people'
     LIMIT 1`,
    [jobId]
  );
  if (!jobRow) return undefined;
  const rowData = await rows<Row>(
    connection,
    `SELECT *
     FROM import_job_rows
     WHERE job_id = ?
     ORDER BY \`row_number\`, id`,
    [jobId]
  );
  const importRows = rowData.map((row): UserImportRow => {
    const conflict = parsedJson<{
      errors?: string[];
      conflicts?: string[];
      allowedActions?: UserImportRow["allowedActions"];
      snapshot?: UserImportRow["snapshot"];
    }>(row.conflict_json, {});
    return {
      id: String(row.id),
      rowNumber: Number(row.row_number),
      raw: parsedJson(row.raw_payload, {}),
      normalized: parsedJson(row.normalized_payload, {
        name: "",
        phone: "",
        groupId: "",
        groupLocked: false,
        enabled: true
      }),
      errors: conflict.errors ?? [],
      conflicts: conflict.conflicts ?? [],
      allowedActions: conflict.allowedActions ?? ["skip"],
      snapshot: conflict.snapshot,
      decision: parsedJson<UserImportDecision | undefined>(row.decision_json, undefined),
      resultAction: row.result_action ? String(row.result_action) : undefined,
      resultMessage: row.message ? String(row.message) : undefined
    };
  });
  return {
    id: String(jobRow.id),
    type: "people" as const,
    ownerAccountId: String(jobRow.owner_account_id ?? ""),
    sourceName: String(jobRow.source_name),
    sourceHash: String(jobRow.source_hash ?? ""),
    previewVersion: String(jobRow.preview_version ?? ""),
    status: String(jobRow.status) as UserImportJob["status"],
    createdAt: requiredIso(jobRow.created_at),
    updatedAt: requiredIso(jobRow.updated_at ?? jobRow.created_at),
    completedAt: iso(jobRow.completed_at),
    rows: importRows
  };
}

export async function updateUserImportDecisions(
  connection: DatabaseConnection,
  jobId: string,
  ownerAccountId: string,
  updates: Array<{ rowId: string; decision: UserImportDecision }>
) {
  const [job] = await rows<Row>(
    connection,
    `SELECT id, status
     FROM import_jobs
     WHERE id = ? AND type = 'people' AND owner_account_id = ?
     LIMIT 1
     FOR UPDATE`,
    [jobId, ownerAccountId]
  );
  if (!job) throw new Error("导入预览不存在");
  if (String(job.status) !== "preview") throw new Error("导入预览已不能修改");
  const now = new Date();
  for (const update of updates) {
    const result = await execute(
      connection,
      `UPDATE import_job_rows
       SET decision_json = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      [JSON.stringify(update.decision), now, update.rowId, jobId]
    );
    if (result.affectedRows !== 1) throw new Error("导入行不存在");
  }
  await execute(
    connection,
    "UPDATE import_jobs SET updated_at = ? WHERE id = ?",
    [now, jobId]
  );
  const updated = await loadUserImportJob(connection, jobId);
  if (!updated) throw new Error("导入预览不存在");
  return updated;
}

function matchesIdentitySnapshot(
  identity: ManagedChatIdentity | undefined,
  snapshot: { id: string; personId?: string; lastSeenAt: string } | undefined
) {
  if (!identity && !snapshot) return true;
  return Boolean(
    identity
    && snapshot
    && identity.id === snapshot.id
    && identity.personId === snapshot.personId
    && identity.lastSeenAt === snapshot.lastSeenAt
  );
}

export async function applyUserImport(
  connection: DatabaseConnection,
  jobId: string,
  ownerAccountId: string,
  actor: AuthenticatedActor
): Promise<UserImportApplyResult> {
  const [lockedJob] = await rows<Row>(
    connection,
    `SELECT id, status
     FROM import_jobs
     WHERE id = ? AND type = 'people' AND owner_account_id = ?
     LIMIT 1
     FOR UPDATE`,
    [jobId, ownerAccountId]
  );
  if (!lockedJob) throw new Error("导入预览不存在");
  if (String(lockedJob.status) !== "preview") throw new Error("导入预览已不能提交");
  const job = await loadUserImportJob(connection, jobId);
  if (!job) throw new Error("导入预览不存在");
  const selectedRows = job.rows.filter((row) => row.decision && row.decision.action !== "skip");
  const staleRows: UserImportRow[] = [];

  for (const row of selectedRows) {
    const decision = row.decision!;
    const [group] = await rows<Row>(
      connection,
      "SELECT id, enabled FROM user_groups WHERE id = ? LIMIT 1 FOR UPDATE",
      [row.normalized.groupId]
    );
    const users = await listUsers(connection, {
      search: row.normalized.phone,
      page: 1,
      pageSize: 10
    });
    const currentUser = users.users.find((user) => user.phone === row.normalized.phone);
    if (currentUser) await lockedUser(connection, currentUser.personId);
    const currentWechat = row.normalized.wechatExternalUserId
      ? await identityByExternalId(connection, "wechat", row.normalized.wechatExternalUserId)
      : undefined;
    const currentWecom = row.normalized.wecomExternalUserId
      ? await identityByExternalId(connection, "wecom", row.normalized.wecomExternalUserId)
      : undefined;
    const targetPersonId = currentUser?.personId;
    const stale = (
      !group
      || !bool(group.enabled)
      || (decision.action === "add" && Boolean(currentUser))
      || (
        decision.action === "overwrite"
        && (
          !currentUser
          || currentUser.personId !== row.snapshot?.existingUser?.personId
          || currentUser.updatedAt !== row.snapshot?.existingUser?.updatedAt
        )
      )
      || !matchesIdentitySnapshot(currentWechat, row.snapshot?.wechatIdentity)
      || !matchesIdentitySnapshot(currentWecom, row.snapshot?.wecomIdentity)
      || Boolean(
        currentWechat?.personId
        && currentWechat.personId !== targetPersonId
        && !decision.confirmWechatRebind
      )
      || Boolean(
        currentWecom?.personId
        && currentWecom.personId !== targetPersonId
        && !decision.confirmWecomRebind
      )
    );
    if (stale) {
      if (!row.conflicts.includes("stale-preview")) row.conflicts.push("stale-preview");
      row.resultMessage = "导入数据已变化，请重新处理冲突";
      staleRows.push(row);
    }
  }

  const now = new Date();
  if (staleRows.length > 0) {
    for (const row of staleRows) {
      await execute(
        connection,
        `UPDATE import_job_rows
         SET conflict_json = ?, message = ?, updated_at = ?
         WHERE id = ? AND job_id = ?`,
        [
          JSON.stringify({
            errors: row.errors,
            conflicts: row.conflicts,
            allowedActions: row.allowedActions,
            snapshot: row.snapshot
          }),
          row.resultMessage ?? null,
          now,
          row.id,
          job.id
        ]
      );
    }
    await execute(connection, "UPDATE import_jobs SET updated_at = ? WHERE id = ?", [now, job.id]);
    const staleJob = await loadUserImportJob(connection, job.id);
    if (!staleJob) throw new Error("导入预览不存在");
    return { job: staleJob, stale: true };
  }

  for (const row of job.rows) {
    const decision = row.decision;
    if (!decision || decision.action === "skip") {
      await execute(
        connection,
        `UPDATE import_job_rows
         SET status = 'skipped', result_action = 'skip', message = '已跳过', updated_at = ?
         WHERE id = ? AND job_id = ?`,
        [now, row.id, job.id]
      );
      row.resultAction = "skip";
      row.resultMessage = "已跳过";
      continue;
    }
    const mutation: UserMutation = {
      name: row.normalized.name,
      phone: row.normalized.phone,
      groupId: row.normalized.groupId,
      groupLocked: row.normalized.groupLocked,
      enabled: row.normalized.enabled
    };
    const user = decision.action === "add"
      ? await createUser(connection, mutation, actor)
      : await updateUser(
          connection,
          row.snapshot?.existingUser?.personId ?? row.normalized.phone,
          mutation,
          actor
        );
    if (row.normalized.wechatExternalUserId) {
      const identity = await identityByExternalId(
        connection,
        "wechat",
        row.normalized.wechatExternalUserId
      );
      await bindChatIdentity(connection, {
        userId: user.personId,
        platform: "wechat",
        identityId: identity?.id,
        externalUserId: row.normalized.wechatExternalUserId,
        displayName: identity?.displayName || row.normalized.name,
        confirmedRebindFromPersonId: decision.confirmWechatRebind ? identity?.personId : undefined
      }, actor);
    }
    if (row.normalized.wecomExternalUserId) {
      const identity = await identityByExternalId(
        connection,
        "wecom",
        row.normalized.wecomExternalUserId
      );
      await bindChatIdentity(connection, {
        userId: user.personId,
        platform: "wecom",
        identityId: identity?.id,
        externalUserId: row.normalized.wecomExternalUserId,
        displayName: identity?.displayName || row.normalized.name,
        confirmedRebindFromPersonId: decision.confirmWecomRebind ? identity?.personId : undefined
      }, actor);
    }
    row.resultAction = decision.action;
    row.resultMessage = decision.action === "add" ? "新增成功" : "覆盖成功";
    await execute(
      connection,
      `UPDATE import_job_rows
       SET status = 'success', result_action = ?, message = ?, updated_at = ?
       WHERE id = ? AND job_id = ?`,
      [row.resultAction, row.resultMessage, now, row.id, job.id]
    );
  }

  await execute(
    connection,
    `UPDATE import_jobs
     SET status = 'completed',
         success_rows = ?,
         failed_rows = 0,
         updated_at = ?,
         completed_at = ?
     WHERE id = ?`,
    [selectedRows.length, now, now, job.id]
  );
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "user_import.commit",
    targetType: "import_job",
    targetId: job.id,
    detail: {
      sourceName: job.sourceName,
      totalRows: job.rows.length,
      selectedRows: selectedRows.length,
      addedRows: job.rows.filter((row) => row.resultAction === "add").length,
      overwrittenRows: job.rows.filter((row) => row.resultAction === "overwrite").length
    },
    now
  });
  const completed = await loadUserImportJob(connection, job.id);
  if (!completed) throw new Error("导入结果不可用");
  return { job: completed, stale: false };
}

export async function usableAdminCount(connection: DatabaseConnection) {
  const [result] = await rows<Row>(
    connection,
    `SELECT COUNT(DISTINCT a.id) AS total
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     JOIN account_credentials c ON c.account_id = a.id
     JOIN account_roles ar ON ar.account_id = a.id
     JOIN roles r ON r.id = ar.role_id
       AND r.source_group_id = p.group_id
       AND r.enabled = true
     JOIN role_permissions rp ON rp.role_id = r.id
       AND rp.permission_code = 'admin.access'
     JOIN user_groups g ON g.id = p.group_id
       AND g.enabled = true
     WHERE a.enabled = true
       AND p.enabled = true`
  );
  return Number(result?.total ?? 0);
}

export async function userDeletionHistory(
  connection: DatabaseConnection,
  userId: string
): Promise<UserDeletionHistory> {
  const [current] = await rows<Row>(
    connection,
    `SELECT a.id AS account_id, p.id AS person_id
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     WHERE p.id = ? OR a.id = ?
     LIMIT 1`,
    [userId, userId]
  );
  if (!current) throw new Error("用户不存在");

  const accountId = String(current.account_id);
  const personId = String(current.person_id);
  const identityRows = await rows<Row>(
    connection,
    "SELECT id FROM chat_identities WHERE person_id = ?",
    [personId]
  );
  const identityIds = identityRows.map((row) => String(row.id));
  const identityPlaceholders = identityIds.map(() => "?").join(", ");
  const identityCondition = (column: string) => (
    identityIds.length > 0 ? ` OR ${column} IN (${identityPlaceholders})` : ""
  );
  const reasons: string[] = [];

  const hasRows = async (sql: string, params: SqlValue[]) => {
    const [result] = await rows<Row>(connection, sql, params);
    return Number(result?.total ?? 0) > 0;
  };

  if (await hasRows(
    `SELECT COUNT(*) AS total
     FROM tickets t
     WHERE t.reporter_person_id = ?
       OR t.submitter_id IN (?, ?)
       OR t.handler_id IN (?, ?)
       ${identityCondition("t.reporter_chat_identity_id")}
       OR EXISTS (
         SELECT 1 FROM ticket_feedback_users f
         WHERE f.ticket_id = t.id AND f.user_id IN (?, ?)
       )
       OR EXISTS (
         SELECT 1 FROM ticket_replies r
         WHERE r.ticket_id = t.id AND r.author_id IN (?, ?)
       )`,
    [
      personId,
      personId,
      accountId,
      personId,
      accountId,
      ...identityIds,
      personId,
      accountId,
      personId,
      accountId
    ]
  )) reasons.push("tickets");

  if (await hasRows(
    `SELECT COUNT(*) AS total
     FROM inbound_messages m
     WHERE m.reporter_person_id = ?
       ${identityCondition("m.reporter_chat_identity_id")}`,
    [personId, ...identityIds]
  )) reasons.push("inboundMessages");

  if (await hasRows(
    `SELECT COUNT(*) AS total
     FROM pending_work_order_sessions s
     WHERE s.person_id = ?
       ${identityCondition("s.chat_identity_id")}`,
    [personId, ...identityIds]
  )) reasons.push("pendingSessions");

  if (await hasRows(
    `SELECT COUNT(*) AS total
     FROM outbound_messages o
     WHERE 1 = 0
       ${identityCondition("o.target_chat_identity_id")}
       OR EXISTS (
         SELECT 1 FROM pending_work_order_sessions s
         WHERE s.id = o.related_session_id
           AND (s.person_id = ? ${identityCondition("s.chat_identity_id")})
       )`,
    [...identityIds, personId, ...identityIds]
  )) reasons.push("outboundMessages");

  if (await hasRows(
    "SELECT COUNT(*) AS total FROM conversation_people WHERE person_id = ?",
    [personId]
  )) reasons.push("conversations");

  if (await hasRows(
    "SELECT COUNT(*) AS total FROM audit_logs WHERE actor_id IN (?, ?)",
    [personId, accountId]
  )) reasons.push("auditLogs");

  return { deletable: reasons.length === 0, reasons };
}

async function ensureUniquePhone(
  connection: DatabaseConnection,
  phone: string,
  exceptAccountId?: string
) {
  const [duplicate] = await rows<Row>(
    connection,
    `SELECT a.id
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     WHERE (a.login_name = ? OR p.phone = ?)
       ${exceptAccountId ? "AND a.id <> ?" : ""}
     LIMIT 1`,
    exceptAccountId ? [phone, phone, exceptAccountId] : [phone, phone]
  );
  if (duplicate) throw new Error("手机号已被其他用户使用");
}

export async function createUser(
  connection: DatabaseConnection,
  input: UserMutation,
  actor: AuthenticatedActor
) {
  const phone = normalizePhone(input.phone);
  await ensureUniquePhone(connection, phone);
  const group = await enabledGroup(connection, input.groupId, true);
  const now = new Date();
  const personId = `person-${randomUUID()}`;
  const accountId = `account-${randomUUID()}`;
  await execute(
    connection,
    `INSERT INTO people (
       id, name, phone, role, group_id, group_name_snapshot, group_locked,
       name_conflict, booth_scope, enabled, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    [
      personId,
      input.name.trim(),
      phone,
      personRole(group),
      input.groupId,
      String(group.name),
      input.groupLocked,
      input.enabled,
      now,
      now
    ]
  );
  await execute(
    connection,
    `INSERT INTO accounts (
       id, person_id, login_name, enabled, auth_version, last_login_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, NULL, ?, ?)`,
    [accountId, personId, phone, input.enabled, now, now]
  );
  await assignAccountRole(connection, accountId, input.groupId, now);
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "user.create",
    targetType: "user",
    targetId: personId,
    detail: {
      name: input.name.trim(),
      phone,
      groupId: input.groupId,
      groupLocked: input.groupLocked,
      enabled: input.enabled
    },
    now
  });
  const created = await getUser(connection, personId);
  if (!created) throw new Error("用户创建失败");
  return created;
}

async function lockedUser(connection: DatabaseConnection, userId: string) {
  const [user] = await rows<Row>(
    connection,
    `SELECT
       a.id AS account_id,
       a.person_id,
       a.login_name,
       a.enabled AS account_enabled,
       p.name,
       p.phone,
       p.group_id,
       p.group_locked,
       p.enabled AS person_enabled
     FROM accounts a
     JOIN people p ON p.id = a.person_id
     WHERE p.id = ? OR a.id = ?
     LIMIT 1
     FOR UPDATE`,
    [userId, userId]
  );
  if (!user) throw new Error("用户不存在");
  return user;
}

export async function updateUser(
  connection: DatabaseConnection,
  userId: string,
  input: Partial<UserMutation>,
  actor: AuthenticatedActor
) {
  const current = await lockedUser(connection, userId);
  const accountId = String(current.account_id);
  const personId = String(current.person_id);
  const phone = input.phone === undefined ? String(current.phone) : normalizePhone(input.phone);
  if (phone !== String(current.phone) || phone !== String(current.login_name)) {
    await ensureUniquePhone(connection, phone, accountId);
  }
  let groupId = String(current.group_id);
  let group: Row | undefined;
  if (input.groupId !== undefined) {
    groupId = input.groupId;
    group = await enabledGroup(connection, groupId, true);
  } else {
    group = await enabledGroup(connection, groupId, true);
  }
  const now = new Date();
  const enabled = input.enabled ?? (bool(current.person_enabled) && bool(current.account_enabled));
  const groupLocked = input.groupLocked ?? bool(current.group_locked);
  const currentUser = await getUser(connection, personId);
  const wasUsableAdmin = Boolean(
    currentUser?.enabled
    && currentUser.hasPassword
    && currentUser.permissions.includes("admin.access")
  );
  const remainsUsableAdmin = Boolean(enabled && currentUser?.hasPassword && bool(group.can_admin));
  if (wasUsableAdmin && !remainsUsableAdmin && await usableAdminCount(connection) <= 1) {
    throw new Error("必须保留至少一位可用后台管理员");
  }
  const invalidate = phone !== String(current.phone)
    || groupId !== String(current.group_id)
    || enabled !== (bool(current.person_enabled) && bool(current.account_enabled))
    || groupLocked !== bool(current.group_locked);
  await execute(
    connection,
    `UPDATE people
     SET name = ?, phone = ?, role = ?, group_id = ?, group_name_snapshot = ?,
         group_locked = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [
      input.name?.trim() ?? String(current.name),
      phone,
      personRole(group),
      groupId,
      String(group.name),
      groupLocked,
      enabled,
      now,
      personId
    ]
  );
  await execute(
    connection,
    `UPDATE accounts
     SET login_name = ?, enabled = ?, updated_at = ?
     WHERE id = ?`,
    [phone, enabled, now, accountId]
  );
  if (groupId !== String(current.group_id)) {
    await assignAccountRole(connection, accountId, groupId, now);
  }
  if (invalidate) {
    await revokeAccountSessionsInternal(connection, accountId, now, true);
  }
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "user.update",
    targetType: "user",
    targetId: personId,
    detail: { changes: input, authInvalidated: invalidate },
    now
  });
  const updated = await getUser(connection, personId);
  if (!updated) throw new Error("用户更新失败");
  return updated;
}

export async function setUserEnabled(
  connection: DatabaseConnection,
  userId: string,
  enabled: boolean,
  actor: AuthenticatedActor
) {
  return updateUser(connection, userId, { enabled }, actor);
}

export async function deleteUser(
  connection: DatabaseConnection,
  userId: string,
  actor: AuthenticatedActor
) {
  const current = await lockedUser(connection, userId);
  const accountId = String(current.account_id);
  const personId = String(current.person_id);
  const currentUser = await getUser(connection, personId);
  if (
    currentUser?.enabled
    && currentUser.hasPassword
    && currentUser.permissions.includes("admin.access")
    && await usableAdminCount(connection) <= 1
  ) {
    throw new Error("必须保留至少一位可用后台管理员");
  }
  const history = await userDeletionHistory(connection, personId);
  if (!history.deletable) throw new Error("该用户已有历史记录，仅可停用");
  await execute(
    connection,
    `UPDATE chat_identities
     SET person_id = NULL, verified_by = NULL, verified_at = NULL
     WHERE person_id = ?`,
    [personId]
  );
  await execute(connection, "DELETE FROM account_sessions WHERE account_id = ?", [accountId]);
  await execute(connection, "DELETE FROM account_credentials WHERE account_id = ?", [accountId]);
  await execute(connection, "DELETE FROM account_roles WHERE account_id = ?", [accountId]);
  await execute(connection, "DELETE FROM accounts WHERE id = ?", [accountId]);
  await execute(connection, "DELETE FROM people WHERE id = ?", [personId]);
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "user.delete",
    targetType: "user",
    targetId: personId,
    detail: { accountId, phone: String(current.phone) }
  });
}

export async function setUserPassword(
  connection: DatabaseConnection,
  userId: string,
  passwordHash: string,
  actor: AuthenticatedActor
) {
  const current = await lockedUser(connection, userId);
  const accountId = String(current.account_id);
  const now = new Date();
  await execute(
    connection,
    `INSERT INTO account_credentials (
       account_id, password_hash, password_changed_at, must_change_password, failed_attempts, locked_until
     ) VALUES (?, ?, ?, false, 0, NULL)
     ON DUPLICATE KEY UPDATE
       password_hash = VALUES(password_hash),
       password_changed_at = VALUES(password_changed_at),
       must_change_password = false,
       failed_attempts = 0,
       locked_until = NULL`,
    [accountId, passwordHash, now]
  );
  await revokeAccountSessionsInternal(connection, accountId, now, true);
  await appendAudit(connection, {
    actorId: actor.accountId,
    actorName: actor.name,
    action: "user.password.set",
    targetType: "user",
    targetId: String(current.person_id),
    detail: { passwordChanged: true },
    now
  });
}
