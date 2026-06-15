import type {
  AuthenticatedActor,
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

const MOBILE_SESSION_DAYS = 7;

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

function normalizeName(name: string) {
  const normalized = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) throw new AuthError(400, "User name is required");
  return normalized;
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

  const { actor } = await repository.upsertMobileAccount({
    name,
    phone,
    groupId
  });
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + MOBILE_SESSION_DAYS * 24 * 60 * 60 * 1000);
  await repository.createAccountSession(
    actor.accountId,
    "mobile",
    sessionTokenHash(token),
    expiresAt.toISOString()
  );
  return { actor, token, expiresAt };
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
