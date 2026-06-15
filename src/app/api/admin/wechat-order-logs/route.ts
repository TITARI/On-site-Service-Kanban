import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { getAppRepository } from "@/lib/repositories/app-repository";

function queryLimit(request: Request) {
  const url = new URL(request.url);
  const parsed = Number(url.searchParams.get("limit") ?? 100);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(500, Math.max(1, Math.trunc(parsed)));
}

export async function GET(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  const logs = await getAppRepository().listWechatOrderLogs(queryLimit(request));
  return NextResponse.json({ logs });
}
