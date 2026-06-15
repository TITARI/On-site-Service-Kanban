import { NextResponse } from "next/server";
import { sessionUserFromActor } from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  adminLogin,
  authErrorResponse
} from "@/lib/services/auth-service";
import { sessionCookie } from "@/lib/services/session-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const { actor, token, expiresAt } = await adminLogin(
      getAppRepository(),
      {
        phone: String(payload?.phone ?? ""),
        password: String(payload?.password ?? "")
      }
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
