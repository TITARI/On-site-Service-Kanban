import { NextResponse } from "next/server";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  setUserPassword,
  userAdminErrorStatus
} from "@/lib/services/user-admin-service";

type Context = { params: Promise<{ userId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId } = await params;
  try {
    const body = await parseJson(request) as { password?: unknown };
    await setUserPassword(
      getAppRepository(),
      userId,
      body.password,
      auth.actor
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}
