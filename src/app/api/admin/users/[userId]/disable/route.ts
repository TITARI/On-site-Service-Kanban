import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import { disableUser, userAdminErrorStatus } from "@/lib/services/user-admin-service";

type Context = { params: Promise<{ userId: string }> };

export async function POST(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId } = await params;
  try {
    const user = await disableUser(getAppRepository(), userId, auth.actor);
    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}
