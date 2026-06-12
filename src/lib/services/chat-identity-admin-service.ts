import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  AuthenticatedActor,
  ManagedChatIdentity
} from "../domain/access-control";
import type { MessageChannel } from "../domain/types";
import type { AppRepository } from "../repositories/app-repository";

const FIVE_MINUTES_MS = 5 * 60 * 1000;

const bindingSchema = z.object({
  userId: z.string().trim().min(1),
  platform: z.enum(["wechat", "wecom"]),
  identityId: z.string().trim().min(1).optional(),
  externalUserId: z.string().trim().min(1).max(191).optional(),
  displayName: z.string().trim().max(191).optional(),
  confirmationToken: z.string().trim().min(1).optional()
}).refine((input) => Boolean(input.identityId || input.externalUserId), {
  message: "请选择已识别账号或填写稳定账号标识"
});

type RebindClaim = {
  platform: MessageChannel;
  identityId: string;
  fromPersonId: string;
  toPersonId: string;
  expiresAt: string;
};

type ServiceOptions = {
  env?: Partial<NodeJS.ProcessEnv>;
  now?: Date;
};

export class ChatIdentityAdminError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly confirmationToken?: string;
  readonly conflict?: {
    identityId: string;
    platform: MessageChannel;
    externalUserId: string;
    displayName: string;
    personId: string;
    personName?: string;
    personPhone?: string;
  };

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      confirmationToken?: string;
      conflict?: ChatIdentityAdminError["conflict"];
    } = {}
  ) {
    super(message);
    this.name = "ChatIdentityAdminError";
    this.status = options.status ?? 400;
    this.code = options.code;
    this.confirmationToken = options.confirmationToken;
    this.conflict = options.conflict;
  }
}

function confirmationSecret(options: ServiceOptions) {
  const env = { ...process.env, ...options.env };
  const configured = env.AUTH_CONFIRMATION_SECRET?.trim();
  if (configured) return configured;
  if (env.NODE_ENV !== "production") {
    const legacy = env.ADMIN_BOOTSTRAP_PASSWORD?.trim();
    if (legacy) return legacy;
  }
  throw new ChatIdentityAdminError("换绑确认密钥未配置", { status: 500 });
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function issueConfirmationToken(claim: RebindClaim, secret: string) {
  const payload = encode(JSON.stringify(claim));
  return `${payload}.${signature(payload, secret)}`;
}

function parseConfirmationToken(token: string, secret: string): RebindClaim {
  const [payload, receivedSignature, extra] = token.split(".");
  if (!payload || !receivedSignature || extra) {
    throw new ChatIdentityAdminError("换绑确认已失效，请重新操作", { status: 409 });
  }
  const expected = Buffer.from(signature(payload, secret));
  const received = Buffer.from(receivedSignature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new ChatIdentityAdminError("换绑确认已失效，请重新操作", { status: 409 });
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RebindClaim;
  } catch {
    throw new ChatIdentityAdminError("换绑确认已失效，请重新操作", { status: 409 });
  }
}

function verifyConfirmationToken(
  token: string,
  expected: Omit<RebindClaim, "expiresAt">,
  options: ServiceOptions
) {
  const claim = parseConfirmationToken(token, confirmationSecret(options));
  const expiresAt = Date.parse(claim.expiresAt);
  const now = options.now ?? new Date();
  if (
    !Number.isFinite(expiresAt)
    || expiresAt <= now.getTime()
    || claim.platform !== expected.platform
    || claim.identityId !== expected.identityId
    || claim.fromPersonId !== expected.fromPersonId
    || claim.toPersonId !== expected.toPersonId
  ) {
    throw new ChatIdentityAdminError("换绑确认已失效，请重新操作", { status: 409 });
  }
}

async function selectedIdentity(
  repository: AppRepository,
  input: z.infer<typeof bindingSchema>
) {
  if (input.identityId) return await repository.getChatIdentity(input.identityId);
  return await repository.identityByExternalId(input.platform, input.externalUserId!);
}

export async function listManagedIdentities(
  repository: AppRepository,
  platform?: MessageChannel
) {
  return (await repository.listChatIdentities(platform))
    .filter((identity) => !identity.isTemporary);
}

export async function bindIdentity(
  repository: AppRepository,
  input: unknown,
  actor: AuthenticatedActor,
  options: ServiceOptions = {}
) {
  const parsed = bindingSchema.safeParse(input);
  if (!parsed.success) {
    throw new ChatIdentityAdminError(parsed.error.issues[0]?.message ?? "账号绑定信息无效");
  }
  const target = await repository.getUser(parsed.data.userId);
  if (!target) throw new ChatIdentityAdminError("用户不存在", { status: 404 });

  const identity = await selectedIdentity(repository, parsed.data);
  if (parsed.data.identityId && !identity) {
    throw new ChatIdentityAdminError("账号身份不存在", { status: 404 });
  }
  if (identity?.platform !== undefined && identity.platform !== parsed.data.platform) {
    throw new ChatIdentityAdminError("账号身份平台不匹配");
  }
  if (identity?.isTemporary) {
    throw new ChatIdentityAdminError("临时身份不能绑定，请等待稳定账号标识");
  }

  let confirmedRebindFromPersonId: string | undefined;
  if (identity?.personId && identity.personId !== target.personId) {
    const claim = {
      platform: parsed.data.platform,
      identityId: identity.id,
      fromPersonId: identity.personId,
      toPersonId: target.personId
    };
    if (!parsed.data.confirmationToken) {
      const now = options.now ?? new Date();
      const confirmationToken = issueConfirmationToken({
        ...claim,
        expiresAt: new Date(now.getTime() + FIVE_MINUTES_MS).toISOString()
      }, confirmationSecret(options));
      throw new ChatIdentityAdminError("该账号已绑定其他用户，需要确认换绑", {
        status: 409,
        code: "IDENTITY_CONFLICT",
        confirmationToken,
        conflict: {
          identityId: identity.id,
          platform: identity.platform,
          externalUserId: identity.externalUserId,
          displayName: identity.displayName,
          personId: identity.personId,
          personName: identity.personName,
          personPhone: identity.personPhone
        }
      });
    }
    verifyConfirmationToken(parsed.data.confirmationToken, claim, options);
    confirmedRebindFromPersonId = identity.personId;
  }

  const externalUserId = identity?.externalUserId ?? parsed.data.externalUserId!;
  return await repository.bindChatIdentity({
    userId: target.personId,
    platform: parsed.data.platform,
    identityId: identity?.id,
    externalUserId,
    displayName: parsed.data.displayName?.trim() || identity?.displayName || externalUserId,
    confirmedRebindFromPersonId
  }, actor);
}

export async function unbindIdentity(
  repository: AppRepository,
  userId: string,
  platform: MessageChannel,
  actor: AuthenticatedActor
) {
  const target = await repository.getUser(userId);
  if (!target) throw new ChatIdentityAdminError("用户不存在", { status: 404 });
  return await repository.unbindChatIdentity(target.personId, platform, actor);
}

export function chatIdentityErrorResponse(error: unknown) {
  if (error instanceof ChatIdentityAdminError) {
    return {
      status: error.status,
      body: {
        message: error.message,
        code: error.code,
        confirmationToken: error.confirmationToken,
        conflict: error.conflict
      }
    };
  }
  const message = error instanceof Error ? error.message : "账号绑定操作失败";
  const status = /不存在|not found/i.test(message) ? 404 : /占用|conflict/i.test(message) ? 409 : 400;
  return { status, body: { message } };
}

export type { ServiceOptions };
