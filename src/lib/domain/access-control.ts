import type { MessageChannel, UserGroup } from "./types";

export const PERMISSION_CODES = [
  "ticket.claim",
  "ticket.process",
  "ticket.accept",
  "admin.access"
] as const;

export type PermissionCode = typeof PERMISSION_CODES[number];
export type SessionType = MessageChannel | "admin";

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
  passwordChangedAt?: string;
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
  loginName: string;
  name: string;
  phone: string;
  groupId: string;
  groupName: string;
  permissions: PermissionCode[];
  sessionId: string;
  sessionType: SessionType;
  authVersion: number;
};

export type MobileAccountInput = {
  personId: string;
  loginName: string;
  channel: MessageChannel;
};

export type UserMutation = {
  personId?: string;
  name: string;
  phone: string;
  groupId: string;
  groupLocked: boolean;
  loginName: string;
  enabled: boolean;
  password?: string;
  mustChangePassword?: boolean;
};

export type BootstrapAdminInput = {
  name: string;
  phone: string;
  loginName: string;
  password: string;
};

export type UserQuery = {
  search?: string;
  groupId?: string;
  enabled?: boolean;
};

export type SessionResolution = {
  session: AccountSession;
  actor: AuthenticatedActor;
};

export type AdminLoginRecord = {
  account: Account;
  credential: AccountCredential;
  role: Role;
  permissionCodes: PermissionCode[];
};

export type AuthBootstrapState = {
  id: string;
  completedAt?: string;
  completedByAccountId?: string;
};

export type UserListItem = {
  personId: string;
  name: string;
  phone: string;
  groupId: string;
  groupName: string;
  groupLocked: boolean;
  accountId: string;
  loginName: string;
  enabled: boolean;
  roleId: string;
  permissionCodes: PermissionCode[];
  lastLoginAt?: string;
};

export function permissionCodesForGroup(group: UserGroup): PermissionCode[] {
  const permissions: PermissionCode[] = [];
  if (group.canClaim) permissions.push("ticket.claim");
  if (group.canProcess) permissions.push("ticket.process");
  if (group.canAccept) permissions.push("ticket.accept");
  if (group.canAdmin) permissions.push("admin.access");
  return permissions;
}
