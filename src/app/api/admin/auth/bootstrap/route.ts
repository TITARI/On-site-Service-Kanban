import { NextResponse } from "next/server";
import { sessionUserFromActor } from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  AuthError,
  authErrorResponse,
  bootstrapFirstAdmin
} from "@/lib/services/auth-service";
import { sessionCookie } from "@/lib/services/session-service";
import type { BootstrapAdminInput } from "@/lib/domain/access-control";

export const dynamic = "force-dynamic";

const BOOTSTRAP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS = 5;
const bootstrapRateLimits = new Map<string, { attempts: number; resetAt: number }>();

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

function assertBootstrapRateLimit(request: Request) {
  const key = bootstrapRateLimitKey(request);
  const now = Date.now();
  const current = bootstrapRateLimits.get(key);
  if (!current || current.resetAt <= now) {
    bootstrapRateLimits.set(key, {
      attempts: 1,
      resetAt: now + BOOTSTRAP_RATE_LIMIT_WINDOW_MS
    });
    return key;
  }

  if (current.attempts >= BOOTSTRAP_RATE_LIMIT_MAX_ATTEMPTS) {
    throw new AuthError(429, "初始化尝试过于频繁，请稍后再试");
  }
  current.attempts += 1;
  return key;
}

export async function POST(request: Request) {
  let rateLimitKey: string | undefined;
  try {
    rateLimitKey = assertBootstrapRateLimit(request);
    const payload = await request.json() as Record<string, unknown>;
    const { actor, token, expiresAt } = await bootstrapFirstAdmin(
      getAppRepository(),
      bootstrapInput(payload),
      process.env
    );
    bootstrapRateLimits.delete(rateLimitKey);
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
