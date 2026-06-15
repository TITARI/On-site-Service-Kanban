import { NextResponse } from "next/server";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  expiredSessionCookie,
  requestSessionToken,
  sessionTokenHash
} from "@/lib/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = requestSessionToken(request, "admin");
  if (token) {
    try {
      await getAppRepository().revokeAccountSession(sessionTokenHash(token));
    } catch {
      // Client logout should still clear the browser cookie if the store is temporarily unavailable.
    }
  }

  return NextResponse.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": expiredSessionCookie("admin")
      }
    }
  );
}
