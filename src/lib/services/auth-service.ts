import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type {
  BootstrapAdminInput,
  PermissionCode,
  SessionType
} from "../domain/access-control";
import { getAppRepository, type AppRepository } from "../repositories/app-repository";
import { userGroupsOf } from "../seed";
import { hashPassword, verifyPassword } from "./password-service";
import {
  createSessionToken,
  requestSessionToken,
  sessionCookie,
  sessionTokenHash
} from "./session-service";

export type MobileLoginInput = {
  name: string;
  phone: string;
  groupId: string;
};

const MOBILE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const ADMIN_LOCK_MS = 15 * 60 * 1000;
const ADMIN_MAX_FAILURES = 5;
const DEFAULT_BOOTSTRAP_PASSWORD = "admin123";
let dummyPasswordHash: Promise<string> | undefined;

export class AuthServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AuthServiceError";
  }
}

function normalizePhone(phone: string) {
  return phone.replace(/\D/g, "");
}

function secureEquals(left: string, right: string) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function adminSessionResult(actor: Awaited<ReturnType<AppRepository["bootstrapAdmin"]>>, now: Date) {
  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MS);
  return {
    actor,
    token,
    expiresAt,
    cookie: sessionCookie("admin", token, expiresAt)
  };
}

async function verifyDummyPassword(password: string) {
  dummyPasswordHash ??= hashPassword("invalid-admin-password");
  await verifyPassword(password, await dummyPasswordHash);
}

export async function mobileLogin(
  repository: AppRepository,
  input: MobileLoginInput,
  now = new Date()
) {
  const name = input.name.trim();
  const phone = normalizePhone(input.phone);
  if (!name) throw new Error("真实姓名不能为空");
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error("手机号格式不正确");
  const config = await repository.getConfig();
  if (!userGroupsOf(config).some((group) => group.id === input.groupId && group.enabled)) {
    throw new Error("用户分组不存在或已停用");
  }

  const { actor } = await repository.upsertMobileAccount({
    name,
    phone,
    groupId: input.groupId
  });
  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + MOBILE_SESSION_MS);
  await repository.createAccountSession(
    actor.accountId,
    "mobile",
    sessionTokenHash(token),
    expiresAt.toISOString()
  );
  return {
    actor,
    token,
    expiresAt,
    cookie: sessionCookie("mobile", token, expiresAt)
  };
}

export async function bootstrapFirstAdmin(
  repository: AppRepository,
  input: BootstrapAdminInput,
  env?: { ADMIN_BOOTSTRAP_PASSWORD?: string },
  now = new Date()
) {
  const status = await repository.bootstrapStatus();
  if (!status.required) throw new AuthServiceError("初始化已完成", 409);

  const legacyPassword = env?.ADMIN_BOOTSTRAP_PASSWORD
    ?? process.env.ADMIN_BOOTSTRAP_PASSWORD
    ?? DEFAULT_BOOTSTRAP_PASSWORD;
  if (!secureEquals(input.legacyPassword, legacyPassword)) {
    throw new AuthServiceError("原后台口令不正确", 401);
  }

  const name = input.name.trim();
  const phone = normalizePhone(input.phone);
  if (!name) throw new AuthServiceError("管理员姓名不能为空", 400);
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new AuthServiceError("手机号格式不正确", 400);
  if (input.group.mode === "create" && !input.group.name.trim()) {
    throw new AuthServiceError("管理员分组名称不能为空", 400);
  }

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_MS);
  const normalizedInput: BootstrapAdminInput = {
    ...input,
    name,
    phone,
    group: input.group.mode === "create"
      ? { mode: "create", name: input.group.name.trim() }
      : input.group
  };
  const actor = await repository.bootstrapAdmin(normalizedInput, {
    sessionType: "admin",
    tokenHash: sessionTokenHash(token),
    expiresAt: expiresAt.toISOString()
  });
  return {
    actor,
    token,
    expiresAt,
    cookie: sessionCookie("admin", token, expiresAt)
  };
}

export async function adminLogin(
  repository: AppRepository,
  phoneInput: string,
  password: string,
  now = new Date()
) {
  const phone = normalizePhone(phoneInput);
  const record = /^1[3-9]\d{9}$/.test(phone)
    ? await repository.adminLoginRecord(phone)
    : undefined;

  if (!record) {
    await verifyDummyPassword(password);
    throw new AuthServiceError("手机号或密码不正确", 401);
  }

  const lockedUntil = record.credential.lockedUntil
    ? Date.parse(record.credential.lockedUntil)
    : Number.NaN;
  if (Number.isFinite(lockedUntil) && lockedUntil > now.getTime()) {
    throw new AuthServiceError("登录尝试过多，请稍后再试", 429);
  }

  const passwordValid = await verifyPassword(password, record.credential.passwordHash);
  const permissionValid = record.actor.permissions.includes("admin.access");
  if (!passwordValid || !permissionValid) {
    const nextFailures = record.credential.failedAttempts + 1;
    const nextLock = nextFailures >= ADMIN_MAX_FAILURES
      ? new Date(now.getTime() + ADMIN_LOCK_MS).toISOString()
      : undefined;
    await repository.recordAdminLoginFailure(record.actor.accountId, nextLock);
    throw new AuthServiceError("手机号或密码不正确", 401);
  }

  await repository.recordAdminLoginSuccess(record.actor.accountId);
  const result = adminSessionResult(record.actor, now);
  await repository.createAccountSession(
    record.actor.accountId,
    "admin",
    sessionTokenHash(result.token),
    result.expiresAt.toISOString()
  );
  return result;
}

export async function resolveRequestActor(
  repository: AppRepository,
  request: Request,
  type: SessionType,
  requiredPermission?: PermissionCode
) {
  const token = requestSessionToken(request, type);
  if (!token) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "未登录" }, { status: 401 })
    };
  }
  const resolution = await repository.resolveAccountSession(sessionTokenHash(token), type);
  if (!resolution) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "登录状态已失效" }, { status: 401 })
    };
  }
  if (requiredPermission && !resolution.actor.permissions.includes(requiredPermission)) {
    return {
      ok: false as const,
      response: NextResponse.json({ message: "没有执行该操作的权限" }, { status: 403 })
    };
  }
  return { ok: true as const, actor: resolution.actor, session: resolution.session };
}

export async function requireRequestActor(
  request: Request,
  type: SessionType,
  requiredPermission: PermissionCode | undefined,
  repository: AppRepository = getAppRepository()
) {
  return resolveRequestActor(repository, request, type, requiredPermission);
}
