import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";

export type CurrentUser = {
  id: string;
  name: string;
  phone: string;
  role: "member";
  groupId?: string;
  groupName?: string;
  permissions?: Pick<UserGroup, "canClaim" | "canProcess" | "canAccept">;
};

export type SessionUser = {
  id: string;
  name: string;
  phone: string;
  role: "member" | "admin";
  groupId?: string;
  groupName?: string;
  permissions?: Pick<UserGroup, "canClaim" | "canProcess" | "canAccept">;
};

export const AUTH_STORAGE_KEY = "internal-board-current-user";

const fallbackPermissions = { canClaim: false, canProcess: false, canAccept: true };

export function normalizePhone(phone: string) {
  return phone.replace(/\s+/g, "").trim();
}

export function createMemberUser(name: string, phone: string, group: UserGroup): CurrentUser {
  const normalizedPhone = normalizePhone(phone);
  return {
    id: `member-${normalizedPhone}`,
    name: name.trim(),
    phone: normalizedPhone,
    role: "member",
    groupId: group.id,
    groupName: group.name,
    permissions: {
      canClaim: group.canClaim,
      canProcess: group.canProcess,
      canAccept: group.canAccept
    }
  };
}

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

export function sessionUserFromActor(actor: AuthenticatedActor): SessionUser {
  if (actor.sessionType === "admin") {
    return {
      id: actor.personId,
      name: actor.name,
      phone: actor.phone,
      role: "admin",
      groupId: actor.groupId,
      groupName: actor.groupName
    };
  }
  return currentUserFromActor(actor);
}

export function readStoredUser(): CurrentUser | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CurrentUser> & { role?: string };
    if (!parsed.id || !parsed.name || parsed.role !== "member") return null;
    return {
      id: parsed.id,
      name: parsed.name,
      phone: parsed.phone ?? "",
      role: "member",
      groupId: parsed.groupId ?? "business",
      groupName: parsed.groupName ?? "business",
      permissions: parsed.permissions ?? fallbackPermissions
    };
  } catch {
    return null;
  }
}

export function storeUser(user: CurrentUser) {
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
}

export function clearStoredUser() {
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
}
