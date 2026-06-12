import { NextResponse } from "next/server";
import { errorMessage, parseJson } from "@/lib/api/errors";
import type { UserQuery } from "@/lib/domain/access-control";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  createUser,
  listUsers,
  userAdminErrorStatus
} from "@/lib/services/user-admin-service";

export const dynamic = "force-dynamic";

function optionalBoolean(value: string | null) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function positiveInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(maximum, parsed);
}

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;

  const params = new URL(request.url).searchParams;
  const page = positiveInteger(params.get("page"), 1, Number.MAX_SAFE_INTEGER);
  const pageSize = positiveInteger(params.get("pageSize"), 20, 200);
  const binding = params.get("binding");
  const query: UserQuery = {
    search: params.get("search")?.trim() || undefined,
    groupId: params.get("groupId")?.trim() || undefined,
    enabled: optionalBoolean(params.get("enabled")),
    admin: optionalBoolean(params.get("admin")),
    binding: binding === "bound" || binding === "unbound" ? binding : undefined,
    page,
    pageSize
  };
  const result = await listUsers(getAppRepository(), query);
  return NextResponse.json({ ...result, page, pageSize });
}

export async function POST(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  try {
    const user = await createUser(
      getAppRepository(),
      await parseJson(request),
      auth.actor
    );
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userAdminErrorStatus(error) }
    );
  }
}
