import { NextResponse } from "next/server";
import type { SessionType } from "@/lib/domain/access-control";
import {
  currentUserFromActor,
  sessionUserFromActor
} from "@/lib/client/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
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
  const sessionType = sessionTypeFromRequest(request);
  try {
    const actor = await resolveRequestActor(request, sessionType);
    if (sessionType === "admin") {
      return NextResponse.json({
        authenticated: true,
        user: sessionUserFromActor(actor)
      });
    }
    return NextResponse.json({ user: currentUserFromActor(actor) });
  } catch (error) {
    if (sessionType === "admin") {
      const status = await getAppRepository().bootstrapStatus();
      return NextResponse.json({
        authenticated: false,
        bootstrapRequired: status.required
      });
    }
    const response = authErrorResponse(error);
    return NextResponse.json(
      { message: response.message },
      { status: response.status }
    );
  }
}
