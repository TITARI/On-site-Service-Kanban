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
  throw new ChatIdentityValidationError("不支持的消息平台");
}

function chatIdentityMessage(error: Error) {
  if (/身份绑定.*重新确认|确认令牌已不匹配/i.test(error.message)) {
    return "身份绑定已变化，请重新确认";
  }
  if (/临时身份/.test(error.message)) {
    return "临时身份不能由管理员绑定";
  }
  if (/身份.*其他用户/.test(error.message)) {
    return "该身份已绑定给其他用户";
  }
  if (/未找到.*(用户|消息身份)|用户.*不存在|消息身份.*不存在/.test(error.message)) {
    return "未找到用户或消息身份";
  }
  return error.message;
}

function chatIdentityErrorResponse(error: unknown) {
  if (error instanceof ChatIdentityConflictError) {
    return NextResponse.json({
      code: error.code,
      message: chatIdentityMessage(error),
      confirmationToken: error.confirmationToken,
      currentOwner: error.currentOwner
    }, { status: 409 });
  }
  if (error instanceof ChatIdentityTemporaryError) {
    return NextResponse.json({
      code: error.code,
      message: chatIdentityMessage(error)
    }, { status: 409 });
  }
  if (error instanceof ChatIdentityNotFoundError) {
    return NextResponse.json({
      code: error.code,
      message: chatIdentityMessage(error)
    }, { status: 404 });
  }
  if (
    error instanceof Error &&
    /身份绑定.*重新确认|确认令牌已不匹配/i.test(error.message)
  ) {
    return NextResponse.json({
      code: "IDENTITY_REBIND_STALE",
      message: chatIdentityMessage(error)
    }, { status: 409 });
  }
  if (error instanceof ChatIdentityValidationError) {
    return badRequest(chatIdentityMessage(error));
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
