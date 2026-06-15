import { NextResponse } from "next/server";
import type { MessageChannel } from "@/lib/domain/types";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createChatIdentityAdminService } from "@/lib/services/chat-identity-admin-service";
import { adminActorOrResponse } from "../users/route-utils";

function platformFrom(value: string | null): MessageChannel | undefined {
  return value === "wechat" || value === "wecom" ? value : undefined;
}

export async function GET(request: Request) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  const url = new URL(request.url);
  const service = createChatIdentityAdminService(getAppRepository());
  const identities = await service.listIdentities(
    platformFrom(url.searchParams.get("platform"))
  );
  return NextResponse.json({ identities });
}
