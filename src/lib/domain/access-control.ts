import type { MessageChannel, UserGroup } from "./types";

export const PERMISSION_CODES = [
  "ticket.claim",
  "ticket.process",
  "ticket.accept",
  "admin.access"
] as const;

export type PermissionCode = typeof PERMISSION_CODES[number];
export type SessionType = "mobile" | "admin";

export type Account = {
  id: string;
  personId: string;
  loginName: string;
  enabled: boolean;
  authVersion: number;
  version?: number;
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

export type Role = {
  id: string;
  name: string;
  sourceGroupId: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AccountRole = {
  accountId: string;
  roleId: string;
  createdAt: string;
};

export type RolePermission = {
  roleId: string;
  permissionCode: PermissionCode;
  createdAt: string;
};

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
  ip?: string;
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
  session: AccountSession;
  actor: AuthenticatedActor;
};

export type AdminLoginRecord = {
  actor: AuthenticatedActor;
  credential: AccountCredential;
};

export type AuthBootstrapState = {
  completedAt?: string;
  completedByAccountId?: string;
};

export type AccessAuditLogEntry = {
  id: string;
  actorId?: string;
  actorName: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail: Record<string, unknown>;
  createdAt: string;
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
  identities: Partial<Record<MessageChannel, {
    id: string;
    externalUserId: string;
    displayName: string;
  }>>;
  version: number;
  updatedAt: string;
};

export function permissionCodesForGroup(group: UserGroup): PermissionCode[] {
  const permissions: PermissionCode[] = [];
  if (group.canClaim) permissions.push("ticket.claim");
  if (group.canProcess) permissions.push("ticket.process");
  if (group.canAccept) permissions.push("ticket.accept");
  if (group.canAdmin) permissions.push("admin.access");
  return permissions;
}
