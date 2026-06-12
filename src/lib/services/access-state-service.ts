import { createHash, randomUUID } from "node:crypto";
import type { AppState } from "../domain/app-state";
import {
  PERMISSION_CODES,
  permissionCodesForGroup,
  type Account,
  type AccountCredential,
  type AccountSession,
  type AdminLoginRecord,
  type AuthenticatedActor,
  type BootstrapAdminInput,
  type ChatIdentityBindingMutation,
  type ManagedChatIdentity,
  type MobileAccountInput,
  type PermissionCode,
  type SessionResolution,
  type SessionType,
  type UserDeletionHistory,
  type UserListItem,
  type UserMutation,
  type UserQuery
} from "../domain/access-control";
import type { MessageChannel, Person, UserGroup } from "../domain/types";
import type { UserImportApplyResult } from "../domain/user-import";

type AccessState = AppState & {
  people: NonNullable<AppState["people"]>;
  chatIdentities: NonNullable<AppState["chatIdentities"]>;
  accounts: NonNullable<AppState["accounts"]>;
  accountCredentials: NonNullable<AppState["accountCredentials"]>;
  roles: NonNullable<AppState["roles"]>;
  accountRoles: NonNullable<AppState["accountRoles"]>;
  rolePermissions: NonNullable<AppState["rolePermissions"]>;
  accountSessions: NonNullable<AppState["accountSessions"]>;
  auditLogs: NonNullable<AppState["auditLogs"]>;
  authBootstrap: NonNullable<AppState["authBootstrap"]>;
};

function nowIso() {
  return new Date().toISOString();
}

function createIdentityId(prefix: "person" | "account") {
  return `${prefix}-${randomUUID()}`;
}

function roleId(groupId: string) {
  return `role-${groupId}`;
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function normalizedIsoDate(value: string, field: string) {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) throw new Error(`${field} must be a valid ISO date string`);

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (
    month < 1
    || month > 12
    || day < 1
    || day > daysInMonth
    || hour > 23
    || minute > 59
    || second > 59
  ) {
    throw new Error(`${field} must be a valid ISO date string`);
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${field} must be a valid ISO date string`);
  return new Date(timestamp).toISOString();
}

export function normalizeMobilePhone(phone: string) {
  const normalized = phone.replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw new Error("Chinese mobile phone number must contain 11 valid digits");
  }
  return normalized;
}

export function normalizeAccessState(state: AppState): AccessState {
  state.people ??= [];
  state.chatIdentities ??= [];
  state.accounts ??= [];
  state.accountCredentials ??= [];
  state.roles ??= [];
  state.accountRoles ??= [];
  state.rolePermissions ??= [];
  state.accountSessions ??= [];
  state.auditLogs ??= [];
  state.authBootstrap ??= {};
  return state as AccessState;
}

export function assertUsableAdminAfterGroupChange(
  stateInput: AppState,
  userGroups: UserGroup[]
) {
  const state = normalizeAccessState(stateInput);
  if (!state.authBootstrap.completedAt) return;

  const adminGroupIds = new Set(
    userGroups
      .filter((group) => group.enabled && group.canAdmin)
      .map((group) => group.id)
  );
  const usableAdminExists = state.accounts.some((account) => {
    if (!account.enabled) return false;
    const person = personForAccount(state, account);
    return Boolean(
      person?.enabled
      && person.groupId
      && adminGroupIds.has(person.groupId)
      && state.accountCredentials.some((credential) => credential.accountId === account.id)
    );
  });
  if (!usableAdminExists) throw new Error("必须保留至少一位可用后台管理员");
}

function groupsOf(state: AppState) {
  return state.config.userGroups ?? [];
}

function groupOf(state: AppState, groupId: string) {
  return groupsOf(state).find((group) => group.id === groupId);
}

function enabledGroup(state: AppState, groupId: string) {
  const group = groupOf(state, groupId);
  if (!group?.enabled) throw new Error("用户分组不存在或已停用");
  return group;
}

function personForAccount(state: AccessState, account: Account) {
  return state.people.find((person) => person.id === account.personId);
}

function permissionsForRole(state: AccessState, id: string): PermissionCode[] {
  const granted = new Set(
    state.rolePermissions
      .filter((permission) => permission.roleId === id)
      .map((permission) => permission.permissionCode)
  );
  return PERMISSION_CODES.filter((permission) => granted.has(permission));
}

function actorForAccount(
  stateInput: AppState,
  account: Account,
  sessionType: SessionType
): AuthenticatedActor | undefined {
  const state = normalizeAccessState(stateInput);
  const person = personForAccount(state, account);
  if (!account.enabled || !person?.enabled || !person.groupId) return undefined;

  const group = groupOf(state, person.groupId);
  const assignments = state.accountRoles.filter((assignment) => assignment.accountId === account.id);
  if (!group?.enabled || assignments.length !== 1) return undefined;

  const role = state.roles.find((item) => item.id === assignments[0].roleId);
  if (!role?.enabled || role.sourceGroupId !== person.groupId) return undefined;

  const permissions = permissionsForRole(state, role.id);
  if (sessionType === "admin" && !permissions.includes("admin.access")) return undefined;

  return {
    accountId: account.id,
    personId: person.id,
    name: person.name,
    phone: person.phone,
    groupId: group.id,
    groupName: group.name,
    permissions,
    sessionType
  };
}

function isUsableAdmin(state: AccessState, account: Account) {
  return Boolean(
    actorForAccount(state, account, "admin")
    && state.accountCredentials.some((credential) => (
      credential.accountId === account.id && Boolean(credential.passwordHash)
    ))
  );
}

export function usableAdminCountFromState(stateInput: AppState) {
  const state = normalizeAccessState(stateInput);
  return state.accounts.filter((account) => isUsableAdmin(state, account)).length;
}

function authorizationFingerprint(state: AccessState, account: Account) {
  const person = personForAccount(state, account);
  const group = person?.groupId ? groupOf(state, person.groupId) : undefined;
  const assignments = state.accountRoles.filter((item) => item.accountId === account.id);
  const role = assignments.length === 1
    ? state.roles.find((item) => item.id === assignments[0].roleId)
    : undefined;
  return JSON.stringify({
    accountEnabled: account.enabled,
    personEnabled: person?.enabled,
    personGroupId: person?.groupId,
    groupEnabled: group?.enabled,
    assignmentIds: assignments.map((item) => item.roleId).sort(),
    roleEnabled: role?.enabled,
    roleSourceGroupId: role?.sourceGroupId,
    permissions: role ? permissionsForRole(state, role.id) : []
  });
}

function revokeSessions(state: AccessState, accountId: string, revokedAt = nowIso()) {
  for (const session of state.accountSessions) {
    if (session.accountId === accountId && !session.revokedAt) session.revokedAt = revokedAt;
  }
}

function invalidateAccount(state: AccessState, account: Account, at = nowIso()) {
  account.authVersion += 1;
  account.updatedAt = at;
  revokeSessions(state, account.id, at);
}

function ensureSingleAccountRole(state: AccessState, account: Account, groupId: string, at = nowIso()) {
  state.accountRoles = state.accountRoles.filter((item) => item.accountId !== account.id);
  state.accountRoles.push({
    accountId: account.id,
    roleId: roleId(groupId),
    createdAt: at
  });
}

function sanitizedValue(value: unknown, key = ""): unknown {
  if (/(password|token|secret|hash|legacy)/i.test(key)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizedValue(item))
      .filter((item) => item !== undefined);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([childKey, childValue]) => [childKey, sanitizedValue(childValue, childKey)] as const)
        .filter((entry) => entry[1] !== undefined)
    );
  }
  return value;
}

function audit(
  state: AccessState,
  action: string,
  targetType: string,
  targetId: string | undefined,
  detail: Record<string, unknown>,
  actor?: AuthenticatedActor
) {
  state.auditLogs.push({
    id: `audit-${randomUUID()}`,
    actorId: actor?.accountId,
    actorName: actor?.name ?? "system",
    action,
    targetType,
    targetId,
    detail: sanitizedValue(detail) as Record<string, unknown>,
    createdAt: nowIso()
  });
}

function synchronizeAccessRoles(
  stateInput: AppState,
  userGroups: UserGroup[],
  actor?: AuthenticatedActor,
  writeAudit = true
) {
  const state = normalizeAccessState(stateInput);
  const before = new Map(state.accounts.map((account) => [
    account.id,
    authorizationFingerprint(state, account)
  ]));
  const at = nowIso();
  const incomingIds = new Set(userGroups.map((group) => group.id));
  const referencedGroupIds = new Set(
    state.accounts
      .map((account) => personForAccount(state, account)?.groupId)
      .filter((id): id is string => Boolean(id))
  );

  state.config.userGroups = userGroups.map((group) => ({ ...group }));

  for (const group of userGroups) {
    const id = roleId(group.id);
    const existing = state.roles.find((role) => role.id === id);
    if (existing) {
      existing.name = group.name;
      existing.sourceGroupId = group.id;
      existing.enabled = group.enabled;
      existing.updatedAt = at;
    } else {
      state.roles.push({
        id,
        name: group.name,
        sourceGroupId: group.id,
        enabled: group.enabled,
        createdAt: at,
        updatedAt: at
      });
    }
  }

  for (const groupId of referencedGroupIds) {
    if (incomingIds.has(groupId)) continue;
    const id = roleId(groupId);
    const existing = state.roles.find((role) => role.id === id);
    if (existing) {
      existing.enabled = false;
      existing.updatedAt = at;
    } else {
      state.roles.push({
        id,
        name: groupId,
        sourceGroupId: groupId,
        enabled: false,
        createdAt: at,
        updatedAt: at
      });
    }
  }

  state.roles = state.roles.filter((role) => (
    incomingIds.has(role.sourceGroupId) || referencedGroupIds.has(role.sourceGroupId)
  ));
  const retainedRoleIds = new Set(state.roles.map((role) => role.id));
  state.rolePermissions = userGroups.flatMap((group) => (
    permissionCodesForGroup(group).map((permissionCode) => ({
      roleId: roleId(group.id),
      permissionCode,
      createdAt: at
    }))
  )).filter((permission) => retainedRoleIds.has(permission.roleId));

  for (const account of state.accounts) {
    const person = personForAccount(state, account);
    if (person?.groupId) ensureSingleAccountRole(state, account, person.groupId, at);
  }
  state.accountRoles = state.accountRoles.filter((assignment) => (
    state.accounts.some((account) => account.id === assignment.accountId)
    && retainedRoleIds.has(assignment.roleId)
  ));

  for (const account of state.accounts) {
    if (before.get(account.id) !== authorizationFingerprint(state, account)) {
      invalidateAccount(state, account, at);
    }
  }

  if (writeAudit) {
    audit(state, "access.roles.sync", "user_groups", undefined, {
      groupIds: userGroups.map((group) => group.id)
    }, actor);
  }
}

export function syncAccessRolesInState(
  state: AppState,
  userGroups: UserGroup[],
  actor?: AuthenticatedActor
) {
  synchronizeAccessRoles(state, userGroups, actor);
}

export function synchronizePersonAccessInState(
  stateInput: AppState,
  personId: string
): { account: Account } {
  const state = normalizeAccessState(stateInput);
  const person = state.people.find((item) => item.id === personId);
  if (!person) throw new Error("用户不存在");

  const group = person.groupId
    ? groupOf(state, person.groupId)
    : groupsOf(state).find((item) => item.name === person.groupName);
  if (!group?.enabled) throw new Error("用户分组不存在或已停用");

  const at = nowIso();
  const phone = normalizeMobilePhone(person.phone);
  person.phone = phone;
  person.groupId = group.id;
  person.groupName = group.name;
  person.groupLocked ??= false;
  synchronizeAccessRoles(state, groupsOf(state), undefined, false);

  let account = state.accounts.find((item) => item.personId === person.id);
  const conflictingAccount = state.accounts.find((item) => (
    item.loginName === phone && item.personId !== person.id
  ));
  if (conflictingAccount) throw new Error("手机号已被其他用户使用");

  if (!account) {
    const preferredId = `account-${person.id}`;
    account = {
      id: state.accounts.some((item) => item.id === preferredId)
        ? createIdentityId("account")
        : preferredId,
      personId: person.id,
      loginName: phone,
      enabled: person.enabled,
      authVersion: 1,
      createdAt: at,
      updatedAt: at
    };
    state.accounts.push(account);
  } else {
    const before = authorizationFingerprint(state, account);
    const loginChanged = account.loginName !== phone;
    account.loginName = phone;
    account.enabled = person.enabled;
    account.updatedAt = at;
    ensureSingleAccountRole(state, account, group.id, at);
    if (loginChanged || before !== authorizationFingerprint(state, account)) {
      invalidateAccount(state, account, at);
    }
  }

  ensureSingleAccountRole(state, account, group.id, at);
  audit(state, "mobile.account.sync", "user", person.id, {
    accountId: account.id,
    groupId: group.id
  });
  return { account };
}

function createPersonAndAccount(
  state: AccessState,
  input: Pick<UserMutation, "name" | "phone" | "groupId" | "groupLocked" | "enabled">,
  at = nowIso()
) {
  const phone = normalizeMobilePhone(input.phone);
  const personId = createIdentityId("person");
  const accountId = createIdentityId("account");
  if (
    state.people.some((person) => person.phone === phone)
    || state.accounts.some((account) => account.loginName === phone)
  ) {
    throw new Error("手机号已被其他用户使用");
  }

  const group = enabledGroup(state, input.groupId);
  const person: Person = {
    id: personId,
    name: input.name.trim(),
    phone,
    role: "handler",
    groupId: group.id,
    groupName: group.name,
    groupLocked: input.groupLocked,
    enabled: input.enabled,
    createdAt: at,
    updatedAt: at
  };
  const account: Account = {
    id: accountId,
    personId,
    loginName: phone,
    enabled: input.enabled,
    authVersion: 1,
    createdAt: at,
    updatedAt: at
  };
  state.people.push(person);
  state.accounts.push(account);
  ensureSingleAccountRole(state, account, group.id, at);
  return { person, account };
}

export function upsertMobileAccountInState(
  stateInput: AppState,
  input: MobileAccountInput
): { actor: AuthenticatedActor } {
  const state = normalizeAccessState(stateInput);
  synchronizeAccessRoles(state, groupsOf(state), undefined, false);
  const phone = normalizeMobilePhone(input.phone);
  const at = nowIso();
  let account = state.accounts.find((item) => item.loginName === phone);
  let person = account ? personForAccount(state, account) : undefined;

  if (!account) {
    ({ account, person } = createPersonAndAccount(state, {
      ...input,
      phone,
      groupLocked: false,
      enabled: true
    }, at));
  } else {
    if (!person) throw new Error("移动账号缺少关联用户");
    if (!account.enabled || !person.enabled) throw new Error("该账号已禁用");

    const effectiveGroupId = person.groupLocked ? person.groupId : input.groupId;
    if (!effectiveGroupId) throw new Error("移动账号未配置用户分组");
    const group = enabledGroup(state, effectiveGroupId);
    const groupChanged = person.groupId !== group.id;
    const phoneChanged = person.phone !== phone || account.loginName !== phone;

    person.name = input.name.trim();
    person.phone = phone;
    person.groupId = group.id;
    person.groupName = group.name;
    person.updatedAt = at;
    account.loginName = phone;
    account.lastLoginAt = at;
    account.updatedAt = at;
    ensureSingleAccountRole(state, account, group.id, at);
    if (groupChanged || phoneChanged) invalidateAccount(state, account, at);
  }

  account.lastLoginAt = at;
  account.updatedAt = at;
  const actor = actorForAccount(state, account, "mobile");
  if (!actor) throw new Error("账号权限链不可用");
  audit(state, "mobile.account.upsert", "user", person.id, {
    groupId: actor.groupId,
    created: person.createdAt === at
  }, actor);
  return { actor };
}

export function createAccountSessionInState(
  stateInput: AppState,
  accountId: string,
  type: SessionType,
  tokenHash: string,
  expiresAt: string
) {
  const state = normalizeAccessState(stateInput);
  const normalizedExpiresAt = normalizedIsoDate(expiresAt, "Session expiry");
  if (Date.parse(normalizedExpiresAt) <= Date.now()) {
    throw new Error("Session expiry must be in the future");
  }
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account || !actorForAccount(state, account, type)) {
    throw new Error("Account is not allowed to create this session");
  }
  if (state.accountSessions.some((session) => session.tokenHash === tokenHash)) {
    throw new Error("Session token hash already exists");
  }

  const at = nowIso();
  const session: AccountSession = {
    id: `session-${randomUUID()}`,
    accountId,
    sessionType: type,
    tokenHash,
    authVersion: account.authVersion,
    expiresAt: normalizedExpiresAt,
    lastSeenAt: at,
    createdAt: at
  };
  state.accountSessions.push(session);
  return session;
}

export function resolveAccountSessionInState(
  stateInput: AppState,
  tokenHash: string,
  type: SessionType
): SessionResolution | undefined {
  const state = normalizeAccessState(stateInput);
  const session = state.accountSessions.find((item) => (
    item.tokenHash === tokenHash && item.sessionType === type
  ));
  if (
    !session
    || session.revokedAt
    || new Date(session.expiresAt).getTime() <= Date.now()
  ) return undefined;

  const account = state.accounts.find((item) => item.id === session.accountId);
  if (!account || session.authVersion !== account.authVersion) return undefined;
  const actor = actorForAccount(state, account, type);
  return actor ? { actor, session } : undefined;
}

export function revokeAccountSessionInState(stateInput: AppState, tokenHash: string) {
  const state = normalizeAccessState(stateInput);
  const session = state.accountSessions.find((item) => item.tokenHash === tokenHash);
  if (!session || session.revokedAt) return;
  session.revokedAt = nowIso();
  audit(state, "session.revoke", "session", session.id, {
    accountId: session.accountId,
    sessionId: session.id,
    sessionType: session.sessionType
  });
}

export function revokeAccountSessionsInState(stateInput: AppState, accountId: string) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return;
  const revokedCount = state.accountSessions.filter((session) => (
    session.accountId === accountId && !session.revokedAt
  )).length;
  invalidateAccount(state, account);
  audit(state, "sessions.revoke", "account", accountId, {
    accountId,
    revokedCount,
    authVersion: account.authVersion
  });
}

export function adminLoginRecordFromState(
  stateInput: AppState,
  phoneInput: string
): AdminLoginRecord | undefined {
  const state = normalizeAccessState(stateInput);
  let phone: string;
  try {
    phone = normalizeMobilePhone(phoneInput);
  } catch {
    return undefined;
  }
  const account = state.accounts.find((item) => item.loginName === phone);
  if (!account) return undefined;
  const credential = state.accountCredentials.find((item) => item.accountId === account.id);
  const actor = actorForAccount(state, account, "admin");
  return credential && actor ? { actor, credential } : undefined;
}

export function recordAdminLoginFailureInState(
  stateInput: AppState,
  accountId: string,
  lockedUntil?: string
) {
  const state = normalizeAccessState(stateInput);
  const normalizedLockedUntil = lockedUntil
    ? normalizedIsoDate(lockedUntil, "Account lock expiry")
    : undefined;
  const credential = state.accountCredentials.find((item) => item.accountId === accountId);
  if (!credential) throw new Error("Admin credential was not found");
  credential.failedAttempts += 1;
  if (normalizedLockedUntil) credential.lockedUntil = normalizedLockedUntil;
  const account = state.accounts.find((item) => item.id === accountId);
  const person = account ? personForAccount(state, account) : undefined;
  audit(state, "admin.login.failure", "account", accountId, {
    failedAttempts: credential.failedAttempts,
    lockedUntil: credential.lockedUntil
  }, account && person ? {
    accountId,
    personId: person.id,
    name: person.name,
    phone: person.phone,
    groupId: person.groupId ?? "",
    groupName: person.groupName,
    permissions: [],
    sessionType: "admin"
  } : undefined);
}

export function recordAdminLoginSuccessInState(stateInput: AppState, accountId: string) {
  const state = normalizeAccessState(stateInput);
  const credential = state.accountCredentials.find((item) => item.accountId === accountId);
  const account = state.accounts.find((item) => item.id === accountId);
  if (!credential || !account) throw new Error("Admin credential was not found");
  credential.failedAttempts = 0;
  credential.lockedUntil = undefined;
  account.lastLoginAt = nowIso();
  account.updatedAt = account.lastLoginAt;
  const actor = actorForAccount(state, account, "admin");
  audit(state, "admin.login.success", "account", accountId, {}, actor);
}

export function bootstrapStatusFromState(stateInput: AppState) {
  const state = normalizeAccessState(stateInput);
  return { required: !state.authBootstrap.completedAt };
}

function createdAdminGroupId(name: string) {
  const digest = createHash("sha256").update(name.trim().toLowerCase()).digest("base64url").slice(0, 16);
  return `admin-${digest}`;
}

export function bootstrapAdminInState(
  stateInput: AppState,
  input: BootstrapAdminInput,
  passwordHash: string
) {
  const state = normalizeAccessState(stateInput);
  if (state.authBootstrap.completedAt) throw new Error("Admin bootstrap has already completed");

  let group: UserGroup;
  if (input.group.mode === "existing") {
    const existing = groupOf(state, input.group.groupId);
    if (!existing) throw new Error("Bootstrap admin group was not found");
    existing.enabled = true;
    existing.canAdmin = true;
    group = existing;
  } else {
    const baseId = createdAdminGroupId(input.group.name);
    let id = baseId;
    while (groupsOf(state).some((item) => item.id === id)) id = `${baseId}-${randomUUID().slice(0, 8)}`;
    group = {
      id,
      name: input.group.name.trim(),
      description: "Bootstrap administrators",
      canClaim: false,
      canProcess: false,
      canAccept: false,
      canAdmin: true,
      enabled: true
    };
    state.config.userGroups = [...groupsOf(state), group];
  }

  synchronizeAccessRoles(state, groupsOf(state), undefined, false);
  const phone = normalizeMobilePhone(input.phone);
  const at = nowIso();
  let account = state.accounts.find((item) => item.loginName === phone);
  let person = account ? personForAccount(state, account) : undefined;
  if (!account) {
    ({ account, person } = createPersonAndAccount(state, {
      name: input.name,
      phone,
      groupId: group.id,
      groupLocked: true,
      enabled: true
    }, at));
  } else {
    if (!person) throw new Error("Bootstrap account has no linked person");
    person.name = input.name.trim();
    person.phone = phone;
    person.groupId = group.id;
    person.groupName = group.name;
    person.groupLocked = true;
    person.enabled = true;
    person.updatedAt = at;
    account.loginName = phone;
    account.enabled = true;
    account.updatedAt = at;
    ensureSingleAccountRole(state, account, group.id, at);
    invalidateAccount(state, account, at);
  }

  const credential: AccountCredential = {
    accountId: account.id,
    passwordHash,
    passwordChangedAt: at,
    mustChangePassword: false,
    failedAttempts: 0
  };
  state.accountCredentials = state.accountCredentials.filter((item) => item.accountId !== account.id);
  state.accountCredentials.push(credential);
  state.authBootstrap = {
    completedAt: at,
    completedByAccountId: account.id
  };

  const actor = actorForAccount(state, account, "admin");
  if (!actor) throw new Error("管理员权限链不可用");
  audit(state, "admin.bootstrap", "account", account.id, {
    groupId: group.id
  }, actor);
  return actor;
}

function userItem(state: AccessState, person: Person, account: Account): UserListItem {
  const group = person.groupId ? groupOf(state, person.groupId) : undefined;
  const permissions = actorForAccount(state, account, "mobile")?.permissions ?? [];
  const identities: UserListItem["identities"] = {};
  for (const identity of state.chatIdentities.filter((item) => item.personId === person.id)) {
    identities[identity.platform] = {
      id: identity.id,
      externalUserId: identity.externalUserId,
      displayName: identity.displayName
    };
  }
  return {
    personId: person.id,
    accountId: account.id,
    name: person.name,
    phone: person.phone,
    groupId: person.groupId ?? "",
    groupName: group?.name ?? person.groupName,
    groupLocked: person.groupLocked ?? false,
    enabled: person.enabled && account.enabled,
    permissions,
    hasPassword: state.accountCredentials.some((item) => item.accountId === account.id && Boolean(item.passwordHash)),
    lastLoginAt: account.lastLoginAt,
    identities,
    updatedAt: person.updatedAt > account.updatedAt ? person.updatedAt : account.updatedAt
  };
}

export function getUserFromState(stateInput: AppState, userId: string) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  if (!account) return undefined;
  const person = personForAccount(state, account);
  return person ? userItem(state, person, account) : undefined;
}

export function listUsersFromState(stateInput: AppState, query: UserQuery) {
  const state = normalizeAccessState(stateInput);
  const search = query.search?.trim().toLowerCase();
  const items = state.accounts.flatMap((account) => {
    const person = personForAccount(state, account);
    return person ? [userItem(state, person, account)] : [];
  }).filter((item) => {
    const bound = Object.keys(item.identities).length > 0;
    const identitySearchValues = Object.values(item.identities).flatMap((identity) => (
      identity ? [identity.externalUserId, identity.displayName] : []
    ));
    return (!search || [item.name, item.phone, item.groupName, ...identitySearchValues].some((value) => value.toLowerCase().includes(search)))
      && (query.groupId === undefined || item.groupId === query.groupId)
      && (query.enabled === undefined || item.enabled === query.enabled)
      && (query.admin === undefined || item.permissions.includes("admin.access") === query.admin)
      && (query.binding === undefined || (query.binding === "bound") === bound);
  }).sort((left, right) => left.name.localeCompare(right.name));

  const page = Math.max(1, query.page);
  const pageSize = Math.max(1, query.pageSize);
  const offset = (page - 1) * pageSize;
  return {
    users: items.slice(offset, offset + pageSize),
    total: items.length
  };
}

function managedIdentity(state: AccessState, identity: AccessState["chatIdentities"][number]): ManagedChatIdentity {
  const person = identity.personId
    ? state.people.find((item) => item.id === identity.personId)
    : undefined;
  return {
    id: identity.id,
    platform: identity.platform,
    externalUserId: identity.externalUserId,
    displayName: identity.displayName,
    isTemporary: Boolean(identity.isTemporary),
    personId: person?.id,
    personName: person?.name,
    personPhone: person?.phone,
    firstSeenAt: identity.firstSeenAt,
    lastSeenAt: identity.lastSeenAt
  };
}

export function listChatIdentitiesFromState(
  stateInput: AppState,
  platform?: MessageChannel
) {
  const state = normalizeAccessState(stateInput);
  return state.chatIdentities
    .filter((identity) => !platform || identity.platform === platform)
    .map((identity) => managedIdentity(state, identity))
    .sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
}

export function getChatIdentityFromState(stateInput: AppState, identityId: string) {
  const state = normalizeAccessState(stateInput);
  const identity = state.chatIdentities.find((item) => item.id === identityId);
  return identity ? managedIdentity(state, identity) : undefined;
}

export function identityByExternalIdFromState(
  stateInput: AppState,
  platform: MessageChannel,
  externalUserId: string
) {
  const state = normalizeAccessState(stateInput);
  const identity = state.chatIdentities.find((item) => (
    item.platform === platform && item.externalUserId === externalUserId
  ));
  return identity ? managedIdentity(state, identity) : undefined;
}

export function bindChatIdentityInState(
  stateInput: AppState,
  input: ChatIdentityBindingMutation,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === input.userId || item.personId === input.userId);
  const person = account ? personForAccount(state, account) : undefined;
  if (!account || !person) throw new Error("用户不存在");

  const externalUserId = input.externalUserId.trim();
  const displayName = input.displayName.trim() || externalUserId;
  let identity = input.identityId
    ? state.chatIdentities.find((item) => item.id === input.identityId)
    : state.chatIdentities.find((item) => (
        item.platform === input.platform && item.externalUserId === externalUserId
      ));
  if (input.identityId && !identity) throw new Error("账号身份不存在");
  if (identity && identity.platform !== input.platform) throw new Error("账号身份平台不匹配");
  if (identity?.isTemporary) throw new Error("临时身份不能绑定，请等待稳定账号标识");

  const fromPersonId = identity?.personId;
  if (fromPersonId && fromPersonId !== person.id) {
    if (input.confirmedRebindFromPersonId !== fromPersonId) {
      throw new Error("账号身份已被其他用户占用");
    }
  }

  const at = nowIso();
  for (const current of state.chatIdentities) {
    if (
      current.personId === person.id
      && current.platform === input.platform
      && current.id !== identity?.id
    ) {
      current.personId = undefined;
      current.verifiedBy = undefined;
      current.verifiedAt = undefined;
    }
  }

  if (identity) {
    identity.personId = person.id;
    identity.displayName = displayName;
    identity.verifiedBy = "admin";
    identity.verifiedAt = at;
    identity.lastSeenAt = at;
  } else {
    identity = {
      id: `identity-${randomUUID()}`,
      platform: input.platform,
      externalUserId,
      displayName,
      isTemporary: false,
      personId: person.id,
      verifiedBy: "admin",
      verifiedAt: at,
      firstSeenAt: at,
      lastSeenAt: at
    };
    state.chatIdentities.push(identity);
  }

  audit(
    state,
    fromPersonId && fromPersonId !== person.id ? "chat_identity.rebind" : "chat_identity.bind",
    "chat_identity",
    identity.id,
    {
      platform: input.platform,
      externalUserId: identity.externalUserId,
      fromPersonId,
      toPersonId: person.id
    },
    actor
  );
  return userItem(state, person, account);
}

export function unbindChatIdentityInState(
  stateInput: AppState,
  userId: string,
  platform: MessageChannel,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  const person = account ? personForAccount(state, account) : undefined;
  if (!account || !person) throw new Error("用户不存在");
  const identities = state.chatIdentities.filter((identity) => (
    identity.personId === person.id && identity.platform === platform
  ));
  for (const identity of identities) {
    identity.personId = undefined;
    identity.verifiedBy = undefined;
    identity.verifiedAt = undefined;
    audit(state, "chat_identity.unbind", "chat_identity", identity.id, {
      platform,
      externalUserId: identity.externalUserId,
      fromPersonId: person.id
    }, actor);
  }
  return userItem(state, person, account);
}

export function createUserInState(
  stateInput: AppState,
  input: UserMutation,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  synchronizeAccessRoles(state, groupsOf(state), undefined, false);
  const created = createPersonAndAccount(state, input);
  const item = userItem(state, created.person, created.account);
  audit(state, "user.create", "user", created.person.id, {
    name: item.name,
    phone: item.phone,
    groupId: item.groupId,
    enabled: item.enabled,
    groupLocked: item.groupLocked
  }, actor);
  return item;
}

export function updateUserInState(
  stateInput: AppState,
  userId: string,
  input: Partial<UserMutation>,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  const person = account ? personForAccount(state, account) : undefined;
  if (!account || !person) throw new Error("User was not found");

  const wasUsableAdmin = isUsableAdmin(state, account);
  const nextEnabled = input.enabled ?? (account.enabled && person.enabled);
  const nextGroup = input.groupId === undefined
    ? (person.groupId ? groupOf(state, person.groupId) : undefined)
    : enabledGroup(state, input.groupId);
  const remainsUsableAdmin = Boolean(nextEnabled && nextGroup?.enabled && nextGroup.canAdmin);
  if (wasUsableAdmin && !remainsUsableAdmin && usableAdminCountFromState(state) <= 1) {
    throw new Error("必须保留至少一位可用后台管理员");
  }

  const at = nowIso();
  let invalidate = false;
  if (input.phone !== undefined) {
    const phone = normalizeMobilePhone(input.phone);
    const duplicate = state.accounts.some((item) => item.id !== account.id && item.loginName === phone);
    if (duplicate) throw new Error("手机号已被其他用户使用");
    if (phone !== account.loginName || phone !== person.phone) {
      account.loginName = phone;
      person.phone = phone;
      invalidate = true;
    }
  }
  if (input.groupId !== undefined && input.groupId !== person.groupId) {
    const group = enabledGroup(state, input.groupId);
    person.groupId = group.id;
    person.groupName = group.name;
    ensureSingleAccountRole(state, account, group.id, at);
    invalidate = true;
  }
  if (input.enabled !== undefined && (account.enabled !== input.enabled || person.enabled !== input.enabled)) {
    account.enabled = input.enabled;
    person.enabled = input.enabled;
    invalidate = true;
  }
  if (input.name !== undefined) person.name = input.name.trim();
  if (input.groupLocked !== undefined && person.groupLocked !== input.groupLocked) {
    person.groupLocked = input.groupLocked;
    invalidate = true;
  }
  person.updatedAt = at;
  account.updatedAt = at;
  if (invalidate) invalidateAccount(state, account, at);

  const item = userItem(state, person, account);
  audit(state, "user.update", "user", person.id, {
    changes: input,
    authInvalidated: invalidate
  }, actor);
  return item;
}

export function setUserEnabledInState(
  state: AppState,
  userId: string,
  enabled: boolean,
  actor: AuthenticatedActor
) {
  return updateUserInState(state, userId, { enabled }, actor);
}

export function deleteUserInState(
  stateInput: AppState,
  userId: string,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  const person = account ? personForAccount(state, account) : undefined;
  if (!account || !person) throw new Error("User was not found");
  if (isUsableAdmin(state, account) && usableAdminCountFromState(state) <= 1) {
    throw new Error("必须保留至少一位可用后台管理员");
  }
  if (!userDeletionHistoryFromState(state, userId).deletable) {
    throw new Error("该用户已有历史记录，仅可停用");
  }

  state.accounts = state.accounts.filter((item) => item.id !== account.id);
  state.people = state.people.filter((item) => item.id !== person.id);
  state.accountCredentials = state.accountCredentials.filter((item) => item.accountId !== account.id);
  state.accountRoles = state.accountRoles.filter((item) => item.accountId !== account.id);
  state.accountSessions = state.accountSessions.filter((item) => item.accountId !== account.id);
  for (const identity of state.chatIdentities) {
    if (identity.personId === person.id) identity.personId = undefined;
  }
  audit(state, "user.delete", "user", person.id, {
    accountId: account.id,
    phone: person.phone
  }, actor);
}

export function userDeletionHistoryFromState(
  stateInput: AppState,
  userId: string
): UserDeletionHistory {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  const person = account ? personForAccount(state, account) : undefined;
  if (!account || !person) throw new Error("User was not found");

  const identityIds = new Set(
    state.chatIdentities
      .filter((identity) => identity.personId === person.id)
      .map((identity) => identity.id)
  );
  const relatedPendingSessionIds = new Set(
    (state.pendingWorkOrderSessions ?? [])
      .filter((session) => (
        session.personId === person.id || identityIds.has(session.chatIdentityId)
      ))
      .map((session) => session.id)
  );
  const ids = new Set([person.id, account.id]);
  const reasons: string[] = [];

  if (state.tickets.some((ticket) => (
    ticket.reporterPersonId === person.id
    || Boolean(ticket.reporterChatIdentityId && identityIds.has(ticket.reporterChatIdentityId))
    || ids.has(ticket.submitterId)
    || Boolean(ticket.handlerId && ids.has(ticket.handlerId))
    || ticket.feedbackUsers.some((feedback) => ids.has(feedback.userId))
    || ticket.replies.some((reply) => ids.has(reply.authorId))
  ))) reasons.push("tickets");

  if (state.messageRecords.some((message) => (
    message.reporterPersonId === person.id
    || Boolean(message.reporterChatIdentityId && identityIds.has(message.reporterChatIdentityId))
  ))) reasons.push("inboundMessages");

  if (relatedPendingSessionIds.size > 0) reasons.push("pendingSessions");

  if ((state.outboundMessages ?? []).some((message) => (
    Boolean(message.targetChatIdentityId && identityIds.has(message.targetChatIdentityId))
    || Boolean(message.relatedSessionId && relatedPendingSessionIds.has(message.relatedSessionId))
  ))) reasons.push("outboundMessages");

  if ((state.conversations ?? []).some((conversation) => conversation.linkedPersonIds.includes(person.id))) {
    reasons.push("conversations");
  }

  if (state.auditLogs.some((entry) => entry.actorId === account.id || entry.actorId === person.id)) {
    reasons.push("auditLogs");
  }

  return { deletable: reasons.length === 0, reasons };
}

export function setUserPasswordInState(
  stateInput: AppState,
  userId: string,
  passwordHash: string,
  actor: AuthenticatedActor
) {
  const state = normalizeAccessState(stateInput);
  const account = state.accounts.find((item) => item.id === userId || item.personId === userId);
  if (!account) throw new Error("User was not found");
  const at = nowIso();
  const credential = state.accountCredentials.find((item) => item.accountId === account.id);
  if (credential) {
    credential.passwordHash = passwordHash;
    credential.passwordChangedAt = at;
    credential.mustChangePassword = false;
    credential.failedAttempts = 0;
    credential.lockedUntil = undefined;
  } else {
    state.accountCredentials.push({
      accountId: account.id,
      passwordHash,
      passwordChangedAt: at,
      mustChangePassword: false,
      failedAttempts: 0
    });
  }
  invalidateAccount(state, account, at);
  audit(state, "user.password.set", "user", account.personId, {
    passwordChanged: true
  }, actor);
}

function sameIdentitySnapshot(
  identity: AccessState["chatIdentities"][number] | undefined,
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

export function applyUserImportInState(
  stateInput: AppState,
  jobId: string,
  ownerAccountId: string,
  actor: AuthenticatedActor
): UserImportApplyResult {
  const state = normalizeAccessState(stateInput);
  state.userImportJobs ??= [];
  const job = state.userImportJobs.find((item) => item.id === jobId);
  if (!job || job.ownerAccountId !== ownerAccountId) throw new Error("导入预览不存在");
  if (job.status !== "preview") throw new Error("导入预览已不能提交");
  const selectedRows = job.rows.filter((row) => row.decision && row.decision.action !== "skip");
  const staleRows: typeof job.rows = [];

  for (const row of selectedRows) {
    const decision = row.decision!;
    const group = groupOf(state, row.normalized.groupId);
    const account = state.accounts.find((item) => item.loginName === row.normalized.phone);
    const currentUser = account ? getUserFromState(state, account.id) : undefined;
    const currentWechat = row.normalized.wechatExternalUserId
      ? state.chatIdentities.find((identity) => (
          identity.platform === "wechat"
          && identity.externalUserId === row.normalized.wechatExternalUserId
        ))
      : undefined;
    const currentWecom = row.normalized.wecomExternalUserId
      ? state.chatIdentities.find((identity) => (
          identity.platform === "wecom"
          && identity.externalUserId === row.normalized.wecomExternalUserId
        ))
      : undefined;
    const targetPersonId = currentUser?.personId;
    const stale = (
      !group?.enabled
      || (decision.action === "add" && Boolean(currentUser))
      || (
        decision.action === "overwrite"
        && (
          !currentUser
          || currentUser.personId !== row.snapshot?.existingUser?.personId
          || currentUser.updatedAt !== row.snapshot?.existingUser?.updatedAt
        )
      )
      || !sameIdentitySnapshot(currentWechat, row.snapshot?.wechatIdentity)
      || !sameIdentitySnapshot(currentWecom, row.snapshot?.wecomIdentity)
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

  job.updatedAt = nowIso();
  if (staleRows.length > 0) return { job: structuredClone(job), stale: true };

  for (const row of job.rows) {
    const decision = row.decision;
    if (!decision || decision.action === "skip") {
      row.resultAction = "skip";
      row.resultMessage = "已跳过";
      continue;
    }
    const mutation = {
      name: row.normalized.name,
      phone: row.normalized.phone,
      groupId: row.normalized.groupId,
      groupLocked: row.normalized.groupLocked,
      enabled: row.normalized.enabled
    };
    const user = decision.action === "add"
      ? createUserInState(state, mutation, actor)
      : updateUserInState(
          state,
          row.snapshot?.existingUser?.personId ?? row.normalized.phone,
          mutation,
          actor
        );
    if (row.normalized.wechatExternalUserId) {
      const identity = state.chatIdentities.find((item) => (
        item.platform === "wechat"
        && item.externalUserId === row.normalized.wechatExternalUserId
      ));
      bindChatIdentityInState(state, {
        userId: user.personId,
        platform: "wechat",
        identityId: identity?.id,
        externalUserId: row.normalized.wechatExternalUserId,
        displayName: identity?.displayName || row.normalized.name,
        confirmedRebindFromPersonId: decision.confirmWechatRebind ? identity?.personId : undefined
      }, actor);
    }
    if (row.normalized.wecomExternalUserId) {
      const identity = state.chatIdentities.find((item) => (
        item.platform === "wecom"
        && item.externalUserId === row.normalized.wecomExternalUserId
      ));
      bindChatIdentityInState(state, {
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
  }

  job.status = "completed";
  job.completedAt = nowIso();
  job.updatedAt = job.completedAt;
  audit(state, "user_import.commit", "import_job", job.id, {
    sourceName: job.sourceName,
    totalRows: job.rows.length,
    selectedRows: selectedRows.length,
    addedRows: job.rows.filter((row) => row.resultAction === "add").length,
    overwrittenRows: job.rows.filter((row) => row.resultAction === "overwrite").length
  }, actor);
  return { job: structuredClone(job), stale: false };
}
