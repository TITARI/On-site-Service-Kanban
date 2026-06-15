import { NextResponse } from "next/server";
import type { MessageChannel } from "@/lib/domain/types";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  ChatIdentityConflictError,
  ChatIdentityNotFoundError,
  ChatIdentityTemporaryError,
  ChatIdentityValidationError,
  createChatIdentityAdminService
} from "@/lib/services/chat-identity-admin-service";
import { adminActorOrResponse } from "../../../route-utils";

type RouteContext = {
  params: Promise<{ userId: string; platform: string }>;
};

function platformFrom(value: string): MessageChannel {
  if (value === "wechat" || value === "wecom") return value;
  throw new ChatIdentityValidationError("Unsupported chat platform");
}

function chatIdentityErrorResponse(error: unknown) {
  if (error instanceof ChatIdentityConflictError) {
    return NextResponse.json({
      code: error.code,
      message: error.message,
      confirmationToken: error.confirmationToken,
      currentOwner: error.currentOwner
    }, { status: 409 });
  }
  if (error instanceof ChatIdentityTemporaryError) {
    return NextResponse.json({
      code: error.code,
      message: error.message
    }, { status: 409 });
  }
  if (error instanceof ChatIdentityNotFoundError) {
    return NextResponse.json({
      code: error.code,
      message: error.message
    }, { status: 404 });
  }
  if (error instanceof ChatIdentityValidationError) {
    return badRequest(error.message);
  }
  return NextResponse.json(
    { message: errorMessage(error) },
    { status: 500 }
  );
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const params = await context.params;
    const platform = platformFrom(params.platform);
    const body = await parseJson(request);
    const identity = await createChatIdentityAdminService(
      getAppRepository()
    ).bindIdentity({
      ...(body as Record<string, unknown>),
      userId: params.userId,
      platform
    }, auth.actor);
    return NextResponse.json({ identity });
  } catch (error) {
    return chatIdentityErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const params = await context.params;
    await createChatIdentityAdminService(getAppRepository()).unbindIdentity({
      userId: params.userId,
      platform: platformFrom(params.platform)
    }, auth.actor);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return chatIdentityErrorResponse(error);
  }
}
