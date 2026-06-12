import { NextResponse } from "next/server";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  deleteUser,
  getUser,
  updateUser,
  userAdminErrorStatus
} from "@/lib/services/user-admin-service";

type Context = { params: Promise<{ userId: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId } = await params;
  try {
    const user = await getUser(getAppRepository(), userId);
    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId } = await params;
  try {
    const user = await updateUser(
      getAppRepository(),
      userId,
      await parseJson(request),
      auth.actor
    );
    return NextResponse.json({ user });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId } = await params;
  try {
    await deleteUser(getAppRepository(), userId, auth.actor);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}
