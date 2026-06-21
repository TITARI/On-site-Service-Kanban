import type {
  AuthenticatedActor,
  BootstrapAdminInput,
  MobileAccountInput,
  PermissionCode,
  SessionType
} from "@/lib/domain/access-control";
import { getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import {
  createSessionToken,
  requestSessionToken,
  sessionTokenHash
} from "@/lib/services/session-service";
import { verifyPassword } from "@/lib/services/password-service";

const MOBILE_SESSION_DAYS = 7;
const ADMIN_SESSION_DAYS = 1;
const ADMIN_FAILURE_LOCK_THRESHOLD = 5;
const ADMIN_LOCKOUT_MINUTES = 15;
const DEFAULT_ADMIN_BOOTSTRAP_PASSWORD = "admin123";
const GENERIC_ADMIN_PASSWORD_ERROR = "手机号或密码不正确";

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 429,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function normalizePhone(phone: string) {
  const normalized = String(phone ?? "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw new AuthError(400, "手机号需为11位有效号码");
  }
  return normalized;
}

function domainAuthError(error: unknown): AuthError | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  const localizedMessage = localizedDomainAuthMessage(message);
  if (/disabled|not allowed|access chain|已停用|无权|权限链/i.test(message)) {
    return new AuthError(403, localizedMessage);
  }
  if (/group|phone|name|required|valid|分组|手机号|姓名|密码|有效/i.test(message)) {
    return new AuthError(400, localizedMessage);
  }
  return undefined;
}

function localizedDomainAuthMessage(message: string) {
  if (/mobile phone.*11 valid digits/i.test(message)) return "手机号需为11位有效号码";
  if (/user name is required/i.test(message)) return "请填写姓名";
  if (/password.*required/i.test(message)) return "请填写密码";
  if (/user group.*disabled|user group.*missing/i.test(message)) return "用户分组已停用或不存在";
  if (/not allowed|access chain.*disabled/i.test(message)) return "当前账号无权创建该会话";
  if (/无权|权限链/.test(message)) return "当前账号无权创建该会话";
  if (/已停用/.test(message)) return message;
  return message;
}

function normalizeName(name: string) {
  const normalized = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new AuthError(400, "请填写姓名");
  return normalized;
}

function normalizePassword(password: string) {
  const normalized = String(password ?? "");
  if (!normalized) throw new AuthError(400, "请填写密码");
  return normalized;
}

function adminBootstrapPassword(env: NodeJS.ProcessEnv = process.env) {
  const configured = env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error("ADMIN_BOOTSTRAP_PASSWORD is required in production.");
  }
  return DEFAULT_ADMIN_BOOTSTRAP_PASSWORD;
}

async function createAccountSession(
  repository: AppRepository,
  actor: AuthenticatedActor,
  type: SessionType,
  days: number
) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  try {
    await repository.createAccountSession(
      actor.accountId,
      type,
      sessionTokenHash(token),
      expiresAt.toISOString()
    );
  } catch (error) {
    throw domainAuthError(error) ?? error;
  }
  return { actor, token, expiresAt };
}

export async function mobileLogin(
  repository: AppRepository,
  input: MobileAccountInput
): Promise<{ actor: AuthenticatedActor; token: string; expiresAt: Date }> {
  const name = normalizeName(input.name);
  const phone = normalizePhone(input.phone);
  const groupId = String(input.groupId ?? "").trim();
  const config = await repository.getConfig();
  const group = (config.userGroups ?? []).find((item) => item.id === groupId);
  if (!group?.enabled) {
    throw new AuthError(400, "用户分组已停用或不存在");
  }

  let actor: AuthenticatedActor;
  try {
    ({ actor } = await repository.upsertMobileAccount({
      name,
      phone,
      groupId
    }));
  } catch (error) {
    throw domainAuthError(error) ?? error;
  }
  return createAccountSession(repository, actor, "mobile", MOBILE_SESSION_DAYS);
}

export async function bootstrapFirstAdmin(
  repository: AppRepository,
  input: BootstrapAdminInput,
  env: NodeJS.ProcessEnv = process.env
): Promise<{ actor: AuthenticatedActor; token: string; expiresAt: Date }> {
  const status = await repository.bootstrapStatus();
  if (!status.required) {
    throw new AuthError(403, "管理员初始化已完成");
  }

  const legacyPassword = String(input.legacyPassword ?? "");
  if (legacyPassword !== adminBootstrapPassword(env)) {
    throw new AuthError(401, "初始化口令不正确");
  }

  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + ADMIN_SESSION_DAYS * 24 * 60 * 60 * 1000);
  try {
    const { actor } = await repository.bootstrapAdminWithSession(
      input,
      sessionTokenHash(token),
      expiresAt.toISOString()
    );
    return { actor, token, expiresAt };
  } catch (error) {
    throw domainAuthError(error) ?? error;
  }
}

export async function adminLogin(
  repository: AppRepository,
  input: { phone: string; password: string }
): Promise<{ actor: AuthenticatedActor; token: string; expiresAt: Date }> {
  const phone = normalizePhone(input.phone);
  const password = normalizePassword(input.password);
  const record = await repository.adminLoginRecord(phone);
  if (!record) {
    throw new AuthError(401, GENERIC_ADMIN_PASSWORD_ERROR);
  }

  const lockedUntilMs = record.credential.lockedUntil
    ? Date.parse(record.credential.lockedUntil)
    : Number.NaN;
  if (Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now()) {
    throw new AuthError(401, GENERIC_ADMIN_PASSWORD_ERROR);
  }

  const validPassword = await verifyPassword(
    password,
    record.credential.passwordHash
  );
  if (!validPassword) {
    const nextFailures = record.credential.failedAttempts + 1;
    const lockedUntil = nextFailures >= ADMIN_FAILURE_LOCK_THRESHOLD
      ? new Date(Date.now() + ADMIN_LOCKOUT_MINUTES * 60 * 1000).toISOString()
      : undefined;
    await repository.recordAdminLoginFailure(
      record.actor.accountId,
      lockedUntil
    );
    throw new AuthError(401, GENERIC_ADMIN_PASSWORD_ERROR);
  }

  await repository.recordAdminLoginSuccess(record.actor.accountId);
  return createAccountSession(repository, record.actor, "admin", ADMIN_SESSION_DAYS);
}

export function resolveRequestActor(
  request: Request,
  type: SessionType,
  requiredPermission?: PermissionCode
): Promise<AuthenticatedActor>;
export function resolveRequestActor(
  repository: AppRepository,
  request: Request,
  type: SessionType,
  requiredPermission?: PermissionCode
): Promise<AuthenticatedActor>;
export async function resolveRequestActor(
  repositoryOrRequest: AppRepository | Request,
  requestOrType: Request | SessionType,
  typeOrPermission?: SessionType | PermissionCode,
  maybeRequiredPermission?: PermissionCode
) {
  const repository = repositoryOrRequest instanceof Request
    ? getAppRepository()
    : repositoryOrRequest;
  const request = repositoryOrRequest instanceof Request
    ? repositoryOrRequest
    : requestOrType as Request;
  const type = repositoryOrRequest instanceof Request
    ? requestOrType as SessionType
    : typeOrPermission as SessionType;
  const requiredPermission = repositoryOrRequest instanceof Request
    ? typeOrPermission as PermissionCode | undefined
    : maybeRequiredPermission;

  const token = requestSessionToken(request, type);
  if (!token) throw new AuthError(401, "未登录");

  const resolution = await repository.resolveAccountSession(
    sessionTokenHash(token),
    type
  );
  if (!resolution) throw new AuthError(401, "未登录");
  if (
    requiredPermission &&
    !resolution.actor.permissions.includes(requiredPermission)
  ) {
    throw new AuthError(403, "没有访问权限");
  }
  return resolution.actor;
}

export function authErrorResponse(error: unknown) {
  if (error instanceof AuthError) {
    return {
      message: error.message,
      status: error.status
    };
  }
  return {
    message: "认证失败",
    status: 500
  };
}
