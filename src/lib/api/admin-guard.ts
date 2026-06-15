import { NextResponse } from "next/server";
import { authErrorResponse, resolveRequestActor } from "@/lib/services/auth-service";

export async function requireAdminAccess(request: Request) {
  try {
    await resolveRequestActor(request, "admin", "admin.access");
    return undefined;
  } catch (error) {
    const response = authErrorResponse(error);
    return NextResponse.json(
      { message: response.message },
      { status: response.status }
    );
  }
}
