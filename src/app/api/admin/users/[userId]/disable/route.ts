import { NextResponse } from "next/server";
import {
  type RouteContext,
  adminActorOrResponse,
  userAdminErrorResponse,
  userAdminService,
  userIdFrom
} from "../../route-utils";

export async function POST(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const user = await userAdminService().disableUser(
      await userIdFrom(context),
      auth.actor
    );
    return NextResponse.json({ user });
  } catch (error) {
    return userAdminErrorResponse(error);
  }
}
