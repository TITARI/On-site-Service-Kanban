import { NextResponse } from "next/server";
import {
  adminActorOrResponse,
  jsonBody,
  userAdminErrorResponse,
  userAdminService
} from "./route-utils";

function optionalBoolean(value: string | null) {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export async function GET(request: Request) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  const url = new URL(request.url);
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "20", 10) || 20);
  const query = {
    search: url.searchParams.get("search") || undefined,
    groupId: url.searchParams.get("groupId") || undefined,
    enabled: optionalBoolean(url.searchParams.get("enabled")),
    admin: optionalBoolean(url.searchParams.get("admin")),
    binding: (
      url.searchParams.get("binding") === "bound" ||
      url.searchParams.get("binding") === "unbound"
    )
      ? url.searchParams.get("binding") as "bound" | "unbound"
      : undefined,
    page,
    pageSize
  };
  const { users, total } = await userAdminService().listUsers(query);
  return NextResponse.json({ users, total, page, pageSize });
}

export async function POST(request: Request) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const user = await userAdminService().createUser(
      await jsonBody(request),
      auth.actor
    );
    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return userAdminErrorResponse(error);
  }
}
