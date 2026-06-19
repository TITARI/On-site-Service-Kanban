import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AuthenticatedActor } from "@/lib/domain/access-control";
import type { ChatIdentityRebindExpectation, MessageChannel } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";

type RebindClaim = ChatIdentityRebindExpectation & {
  expiresAt: string;
};

const CHANNELS = ["wechat", "wecom"] as const;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

const bindInputSchema = z.object({
  userId: z.string().min(1, "缺少用户ID"),
  platform: z.enum(CHANNELS),
  externalUserId: z.string().trim().min(1, "请填写外部用户标识").max(160, "外部用户标识不能超过160个字符"),
  displayName: z.string().trim().max(160, "显示名称不能超过160个字符").optional(),
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

  constructor(message = "未找到消息身份或用户") {
    super(message);
    this.name = "ChatIdentityNotFoundError";
  }
}

export class ChatIdentityTemporaryError extends Error {
  code = "TEMPORARY_IDENTITY" as const;

  constructor(message = "临时身份不能由管理员绑定") {
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
    "请先配置 AUTH_CONFIRMATION_SECRET 后再确认身份换绑"
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
    throw new ChatIdentityValidationError("确认令牌无效");
  }
  let claim: RebindClaim;
  try {
    claim = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new ChatIdentityValidationError("确认令牌无效");
  }
  const expiresAtMs = Date.parse(claim.expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiresAtMs)) {
    throw new ChatIdentityValidationError("确认令牌过期时间无效");
  }
  if (expiresAtMs <= now) {
    throw new ChatIdentityValidationError("确认令牌已过期");
  }
  if (expiresAtMs > now + CONFIRMATION_TTL_MS) {
    throw new ChatIdentityValidationError("确认令牌有效期过长");
  }
  return claim;
}

function expectedRebindFromClaim(claim: RebindClaim): ChatIdentityRebindExpectation {
  return {
    platform: claim.platform,
    identityId: claim.identityId,
    fromPersonId: claim.fromPersonId,
    toPersonId: claim.toPersonId
  };
}

function staleConfirmationError() {
  return new ChatIdentityValidationError(
    "确认令牌已不匹配当前身份绑定，请重新确认"
  );
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
      if (!user) throw new ChatIdentityNotFoundError("未找到用户");

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
      let expectedRebind: ChatIdentityRebindExpectation | undefined;
      if (parsed.confirmationToken) {
        const claim = parseToken(parsed.confirmationToken, secretFromEnv(env));
        expectedRebind = expectedRebindFromClaim(claim);
        if (
          claim.platform !== parsed.platform ||
          claim.toPersonId !== user.personId ||
          !identity ||
          identity.isTemporary ||
          identity.id !== claim.identityId ||
          identity.platform !== claim.platform ||
          identity.externalUserId !== parsed.externalUserId ||
          identity.personId !== claim.fromPersonId
        ) {
          throw staleConfirmationError();
        }
        confirmedRebind = true;
      } else if (rebindsOccupiedIdentity) {
        expectedRebind = {
          platform: parsed.platform,
          identityId: identity?.id ?? "",
          fromPersonId: ownerPersonId as string,
          toPersonId: user.personId
        };
        const conflictSecret = secretFromEnv(env);
        const owner = await repository.getUser(ownerPersonId as string);
        throw new ChatIdentityConflictError(
          "该身份已绑定给其他用户",
          signClaim({
            ...expectedRebind,
            expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS).toISOString()
          }, conflictSecret),
          {
            personId: ownerPersonId as string,
            name: owner?.name
          }
        );
      }

      return await repository.bindChatIdentity({
        userId: user.personId,
        platform: parsed.platform,
        externalUserId: parsed.externalUserId,
        displayName: parsed.displayName,
        confirmedRebind,
        expectedRebind
      }, actor);
    },

    async unbindIdentity(
      input: { userId: string; platform: MessageChannel },
      actor: AuthenticatedActor
    ) {
      const user = await repository.getUser(input.userId);
      if (!user) throw new ChatIdentityNotFoundError("未找到用户");
      await repository.unbindChatIdentity({
        userId: user.personId,
        platform: input.platform
      }, actor);
    }
  };
}
