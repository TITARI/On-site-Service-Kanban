import { NextResponse } from "next/server";
import { sessionUserFromActor } from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  AuthError,
  authErrorResponse,
  bootstrapFirstAdmin
} from "@/lib/services/auth-service";
import { sessionCookie } from "@/lib/services/session-service";
import type { RateLimiter } from "@/lib/services/rate-limiter";
import type { BootstrapAdminInput } from "@/lib/domain/access-control";

export const dynamic = "force-dynamic";

const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS = 5;

function bootstrapInput(payload: Record<string, unknown>): BootstrapAdminInput {
  const groupPayload = payload.group as
    | { mode?: unknown; groupId?: unknown; name?: unknown }
    | undefined;
  const group = groupPayload?.mode === "existing"
    ? {
        mode: "existing" as const,
        groupId: String(groupPayload.groupId ?? "")
      }
    : {
        mode: "create" as const,
        name: String(groupPayload?.name ?? "")
      };

  return {
    legacyPassword: String(payload.legacyPassword ?? ""),
    name: String(payload.name ?? ""),
    phone: String(payload.phone ?? ""),
    password: String(payload.password ?? ""),
    group
  };
}

function bootstrapRateLimitKey(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for")
    ?.split(",")
    .map((item) => item.trim())
    .find(Boolean);
  if (forwardedFor) return forwardedFor;
  const realIp = request.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp;
  return "unknown";
}

async function assertBootstrapRateLimit(request: Request, rateLimiter: RateLimiter) {
  const key = bootstrapRateLimitKey(request);
  const result = await rateLimiter.checkAndIncrement(
    key,
    BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS,
    BOOTSTRAP_RATE_LIMIT_WINDOW_MS
  );
  if (!result.allowed) {
    throw new AuthError(429, "初始化尝试过于频繁，请稍后再试");
  }
  return key;
}

export async function POST(request: Request) {
  let rateLimitKey: string | undefined;
  try {
    const repository = getAppRepository();
    const rateLimiter = repository.getRateLimiter();
    rateLimitKey = await assertBootstrapRateLimit(request, rateLimiter);
    const payload = await request.json() as Record<string, unknown>;
    const { actor, token, expiresAt } = await bootstrapFirstAdmin(
      repository,
      bootstrapInput(payload),
      process.env
    );
    try {
      await rateLimiter.reset(rateLimitKey);
    } catch (error) {
      console.warn("[bootstrap] 限流计数重置失败", {
        key: rateLimitKey,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString()
      });
    }
    return NextResponse.json(
      { user: sessionUserFromActor(actor) },
      {
        headers: {
          "Set-Cookie": sessionCookie("admin", token, expiresAt)
        }
      }
    );
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json(
      { message: response.message },
      { status: response.status }
    );
  }
}
