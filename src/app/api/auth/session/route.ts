import { NextResponse } from "next/server";
import type { SessionType } from "@/lib/domain/access-control";
import { currentUserFromActor } from "@/lib/client/auth";
import {
  authErrorResponse,
  resolveRequestActor
} from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

function sessionTypeFromRequest(request: Request): SessionType {
  const type = new URL(request.url).searchParams.get("type");
  return type === "admin" ? "admin" : "mobile";
}

export async function GET(request: Request) {
  try {
    const actor = await resolveRequestActor(request, sessionTypeFromRequest(request));
    return NextResponse.json({ user: currentUserFromActor(actor) });
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json(
      { message: response.message },
      { status: response.status }
    );
  }
}
