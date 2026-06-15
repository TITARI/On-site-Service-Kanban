import { NextResponse } from "next/server";
import {
  type RouteContext,
  adminActorOrResponse,
  jsonBody,
  userAdminErrorResponse,
  userAdminService,
  userIdFrom
} from "../route-utils";

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const user = await userAdminService().updateUser(
      await userIdFrom(context),
      await jsonBody(request),
      auth.actor
    );
    return NextResponse.json({ user });
  } catch (error) {
    return userAdminErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    await userAdminService().deleteUser(await userIdFrom(context), auth.actor);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return userAdminErrorResponse(error);
  }
}
