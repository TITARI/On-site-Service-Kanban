import { NextResponse } from "next/server";
import {
  type RouteContext,
  adminActorOrResponse,
  jsonBody,
  userAdminErrorResponse,
  userAdminService,
  userIdFrom
} from "../../route-utils";

export async function POST(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    await userAdminService().setPassword(
      await userIdFrom(context),
      await jsonBody(request),
      auth.actor
    );
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return userAdminErrorResponse(error);
  }
}
