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
const GENERIC_ADMIN_PASSWORD_ERROR = "Invalid phone or password";

export class AuthError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export function normalizePhone(phone: string) {
  const normalized = String(phone ?? "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw new AuthError(400, "Mobile phone must contain 11 valid digits");
  }
  return normalized;
}

function domainAuthError(error: unknown): AuthError | undefined {
  if (!(error instanceof Error)) return undefined;
  const message = error.message;
  if (/disabled|not allowed|access chain/i.test(message)) {
    return new AuthError(403, message);
  }
  if (/group|phone|name|required|valid/i.test(message)) {
    return new AuthError(400, message);
  }
  return undefined;
}

function normalizeName(name: string) {
  const normalized = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new AuthError(400, "User name is required");
  return normalized;
}

function normalizePassword(password: string) {
  const normalized = String(password ?? "");
  if (!normalized) throw new AuthError(400, "Password is required");
  return normalized;
}

function adminBootstrapPassword(env: NodeJS.ProcessEnv = process.env) {
  return env.ADMIN_BOOTSTRAP_PASSWORD ?? DEFAULT_ADMIN_BOOTSTRAP_PASSWORD;
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
    throw new AuthError(400, "User group is disabled or missing");
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
    throw new AuthError(403, "Admin bootstrap has already completed");
  }

  const legacyPassword = String(input.legacyPassword ?? "");
  if (legacyPassword !== adminBootstrapPassword(env)) {
    throw new AuthError(401, "Invalid bootstrap password");
  }

  let actor: AuthenticatedActor;
  try {
    actor = await repository.bootstrapAdmin(input);
  } catch (error) {
    throw domainAuthError(error) ?? error;
  }
  return createAccountSession(repository, actor, "admin", ADMIN_SESSION_DAYS);
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
  if (!token) throw new AuthError(401, "Unauthenticated");

  const resolution = await repository.resolveAccountSession(
    sessionTokenHash(token),
    type
  );
  if (!resolution) throw new AuthError(401, "Unauthenticated");
  if (
    requiredPermission &&
    !resolution.actor.permissions.includes(requiredPermission)
  ) {
    throw new AuthError(403, "Forbidden");
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
    message: "Authentication failed",
    status: 500
  };
}
