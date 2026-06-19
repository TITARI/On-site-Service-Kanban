import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import {
  authErrorResponse,
  resolveRequestActor
} from "@/lib/services/auth-service";
import {
  UserAdminConflictError,
  UserAdminNotFoundError,
  UserAdminValidationError,
  createUserAdminService
} from "@/lib/services/user-admin-service";

export type RouteContext = {
  params: Promise<{ userId: string }>;
};

export async function adminActorOrResponse(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return { response: unauthorized };

  try {
    return {
      actor: await resolveRequestActor(request, "admin", "admin.access")
    };
  } catch (error) {
    const response = authErrorResponse(error);
    return {
      response: NextResponse.json(
        { message: response.message },
        { status: response.status }
      )
    };
  }
}

export function userAdminService() {
  return createUserAdminService(getAppRepository());
}

export async function jsonBody(request: Request) {
  try {
    return await parseJson(request);
  } catch (error) {
    throw new UserAdminValidationError(errorMessage(error));
  }
}

export async function userIdFrom(context: RouteContext) {
  const params = await context.params;
  return params.userId;
}

export function userAdminErrorResponse(error: unknown) {
  if (error instanceof UserAdminValidationError) {
    return badRequest(error.message);
  }
  if (error instanceof UserAdminNotFoundError) {
    return NextResponse.json({ message: error.message }, { status: 404 });
  }
  if (error instanceof UserAdminConflictError) {
    return NextResponse.json({ message: error.message }, { status: 409 });
  }
  if (
    error instanceof Error &&
    /duplicate|手机号.*占用|手机号.*重复|可用管理员|业务历史|不能删除|被引用/i.test(error.message)
  ) {
    return NextResponse.json({ message: error.message }, { status: 409 });
  }
  if (error instanceof Error && /未找到|不存在/i.test(error.message)) {
    return NextResponse.json({ message: error.message }, { status: 404 });
  }
  return NextResponse.json(
    { message: errorMessage(error) },
    { status: 500 }
  );
}
