import { NextResponse } from "next/server";
import { sessionUserFromActor } from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  authErrorResponse,
  bootstrapFirstAdmin
} from "@/lib/services/auth-service";
import { sessionCookie } from "@/lib/services/session-service";
import type { BootstrapAdminInput } from "@/lib/domain/access-control";

export const dynamic = "force-dynamic";

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

export async function POST(request: Request) {
  try {
    const payload = await request.json() as Record<string, unknown>;
    const { actor, token, expiresAt } = await bootstrapFirstAdmin(
      getAppRepository(),
      bootstrapInput(payload),
      process.env
    );
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
