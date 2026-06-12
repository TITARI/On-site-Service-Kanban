import { NextResponse } from "next/server";
import type { MessageChannel } from "@/lib/domain/types";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import { listManagedIdentities } from "@/lib/services/chat-identity-admin-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const value = new URL(request.url).searchParams.get("platform");
  const platform = value === "wechat" || value === "wecom"
    ? value as MessageChannel
    : undefined;
  const identities = await listManagedIdentities(getAppRepository(), platform);
  return NextResponse.json({ identities });
}
