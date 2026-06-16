import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { MessageChannel } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";

type RebindClaim = {
  platform: MessageChannel;
  identityId: string;
  fromPersonId: string;
  toPersonId: string;
  expiresAt: string;
};

const CHANNELS = ["wechat", "wecom"] as const;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const bindInputSchema = z.object({
  userId: z.string().min(1),
  platform: z.enum(CHANNELS),
  externalUserId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().max(160).optional(),
  confirmationToken: z.string().optional()
});

export type ChatIdentityBindInput = z.infer<typeof bindInputSchema>;

export class ChatIdentityValidationError extends Error {
  code = "VALIDATION_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "ChatIdentityValidationError";
  }
}

export class ChatIdentityNotFoundError extends Error {
  code = "NOT_FOUND" as const;

  constructor(message = "Chat identity or user was not found") {
    super(message);
    this.name = "ChatIdentityNotFoundError";
  }
}

export class ChatIdentityTemporaryError extends Error {
  code = "TEMPORARY_IDENTITY" as const;

  constructor(message = "Temporary identities cannot be bound by administrators") {
    super(message);
    this.name = "ChatIdentityTemporaryError";
  }
}

export class ChatIdentityConflictError extends Error {
  code = "IDENTITY_CONFLICT" as const;

  constructor(
    message: string,
    public confirmationToken: string,
    public currentOwner?: { personId: string; name?: string }
  ) {
    super(message);
    this.name = "ChatIdentityConflictError";
  }
}

function secretFromEnv(env: NodeJS.ProcessEnv) {
  if (env.AUTH_CONFIRMATION_SECRET?.trim()) {
    return env.AUTH_CONFIRMATION_SECRET.trim();
  }
  if (
    env.NODE_ENV === "development" &&
    env.ADMIN_BOOTSTRAP_PASSWORD?.trim()
  ) {
    return env.ADMIN_BOOTSTRAP_PASSWORD.trim();
  }
  throw new ChatIdentityValidationError(
    "AUTH_CONFIRMATION_SECRET is required for identity confirmation"
  );
}

function base64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signPayload(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function signClaim(claim: RebindClaim, secret: string) {
  const payload = base64UrlJson(claim);
  return `${payload}.${signPayload(payload, secret)}`;
}

function verifySignature(payload: string, signature: string, secret: string) {
  const expected = Buffer.from(signPayload(payload, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseToken(token: string, secret: string): RebindClaim {
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !verifySignature(payload, signature, secret)) {
    throw new ChatIdentityValidationError("Confirmation token is invalid");
  }
  let claim: RebindClaim;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ChatIdentityValidationError("Confirmation token is invalid");
  }
  const expiresAtMs = Date.parse(claim.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs)) {
    throw new ChatIdentityValidationError("Confirmation token expiry is invalid");
  }
  if (expiresAtMs <= now) {
    throw new ChatIdentityValidationError("Confirmation token has expired");
  }
  if (expiresAtMs > now + CONFIRMATION_TTL_MS) {
    throw new ChatIdentityValidationError("Confirmation token expiry is too long");
  }
  return claim;
}

function assertClaimMatches(
  claim: RebindClaim,
  expected: Omit<RebindClaim, "expiresAt">
) {
  if (
    claim.platform !== expected.platform ||
    claim.identityId !== expected.identityId ||
    claim.fromPersonId !== expected.fromPersonId ||
    claim.toPersonId !== expected.toPersonId
  ) {
    throw new ChatIdentityValidationError(
      "Confirmation token does not match this rebind request"
    );
  }
}

function parseBindInput(input: unknown): ChatIdentityBindInput {
  try {
    return bindInputSchema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ChatIdentityValidationError(
        error.issues.map((issue) => issue.message).join("; ")
      );
    }
    throw error;
  }
}

export function createChatIdentityAdminService(
  repository: AppRepository,
  options: { env?: NodeJS.ProcessEnv } = {}
) {
  const env = options.env ?? process.env;

  return {
    async listIdentities(platform?: MessageChannel) {
      return await repository.listChatIdentities({
        platform,
        stableOnly: true
      });
    },

    async bindIdentity(input: unknown, actor: AuthenticatedActor) {
      const parsed = parseBindInput(input);
      const user = await repository.getUser(parsed.userId);
      if (!user) throw new ChatIdentityNotFoundError("User was not found");

      const identity = await repository.identityByExternalId(
        parsed.platform,
        parsed.externalUserId
      );
      if (identity?.isTemporary) throw new ChatIdentityTemporaryError();

      const ownerPersonId = identity?.personId;
      const rebindsOccupiedIdentity = Boolean(
        identity &&
        ownerPersonId &&
        ownerPersonId !== user.personId
      );
      let confirmedRebind = false;
      if (rebindsOccupiedIdentity) {
        const expected = {
          platform: parsed.platform,
          identityId: identity?.id ?? "",
          fromPersonId: ownerPersonId as string,
          toPersonId: user.personId
        };
        const secret = secretFromEnv(env);
        if (!parsed.confirmationToken) {
          const owner = await repository.getUser(ownerPersonId as string);
          throw new ChatIdentityConflictError(
            "Identity already belongs to another user",
            signClaim({
              ...expected,
              expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString()
            }, secret),
            {
              personId: ownerPersonId as string,
              name: owner?.name
            }
          );
        }
        assertClaimMatches(
          parseToken(parsed.confirmationToken, secret),
          expected
        );
        confirmedRebind = true;
      }

      return await repository.bindChatIdentity({
        userId: user.personId,
        platform: parsed.platform,
        externalUserId: parsed.externalUserId,
        displayName: parsed.displayName,
        confirmedRebind
      }, actor);
    },

    async unbindIdentity(
      input: { userId: string; platform: MessageChannel },
      actor: AuthenticatedActor
    ) {
      const user = await repository.getUser(input.userId);
      if (!user) throw new ChatIdentityNotFoundError("User was not found");
      await repository.unbindChatIdentity({
        userId: user.personId,
        platform: input.platform
      }, actor);
    }
  };
}
