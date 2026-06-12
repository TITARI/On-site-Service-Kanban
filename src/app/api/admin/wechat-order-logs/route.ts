import { NextResponse } from "next/server";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";

function queryLimit(request: Request) {
  const url = new URL(request.url);
  const parsed = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(500, Math.max(1, Math.trunc(parsed)));
}

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const logs = await getAppRepository().listWechatOrderLogs(queryLimit(request));
  return NextResponse.json({ logs });
}
