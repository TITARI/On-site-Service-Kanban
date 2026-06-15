import { NextResponse } from "next/server";
import { currentUserFromActor } from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  authErrorResponse,
  mobileLogin
} from "@/lib/services/auth-service";
import { sessionCookie } from "@/lib/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const { actor, token, expiresAt } = await mobileLogin(
      getAppRepository(),
      {
        name: String(payload?.name ?? ""),
        phone: String(payload?.phone ?? ""),
        groupId: String(payload?.groupId ?? "")
      }
    );
    return NextResponse.json(
      { user: currentUserFromActor(actor) },
      {
        headers: {
          "Set-Cookie": sessionCookie("mobile", token, expiresAt)
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
