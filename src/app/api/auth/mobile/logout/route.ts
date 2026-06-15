import { NextResponse } from "next/server";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  expiredSessionCookie,
  requestSessionToken,
  sessionTokenHash
} from "@/lib/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = requestSessionToken(request, "mobile");
  if (token) {
    await getAppRepository().revokeAccountSession(sessionTokenHash(token));
  }

  return NextResponse.json(
    { ok: true },
    {
      headers: {
        "Set-Cookie": expiredSessionCookie("mobile")
      }
    }
  );
}
