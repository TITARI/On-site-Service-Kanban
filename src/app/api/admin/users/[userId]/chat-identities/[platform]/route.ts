import { NextResponse } from "next/server";
import { parseJson } from "@/lib/api/errors";
import type { MessageChannel } from "@/lib/domain/types";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  bindIdentity,
  chatIdentityErrorResponse,
  unbindIdentity
} from "@/lib/services/chat-identity-admin-service";

type Context = {
  params: Promise<{ userId: string; platform: string }>;
};

function platformOf(value: string): MessageChannel | undefined {
  return value === "wechat" || value === "wecom" ? value : undefined;
}

export async function PUT(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId, platform: value } = await params;
  const platform = platformOf(value);
  if (!platform) return NextResponse.json({ message: "不支持的账号平台" }, { status: 400 });
  try {
    const body = await parseJson(request) as Record<string, unknown>;
    const user = await bindIdentity(getAppRepository(), {
      ...body,
      userId,
      platform
    }, auth.actor);
    return NextResponse.json({ user });
  } catch (error) {
    const response = chatIdentityErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { userId, platform: value } = await params;
  const platform = platformOf(value);
  if (!platform) return NextResponse.json({ message: "不支持的账号平台" }, { status: 400 });
  try {
    const user = await unbindIdentity(getAppRepository(), userId, platform, auth.actor);
    return NextResponse.json({ user });
  } catch (error) {
    const response = chatIdentityErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
