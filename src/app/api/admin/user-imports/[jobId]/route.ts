import { NextResponse } from "next/server";
import { badRequest, errorMessage } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createUserImportService } from "@/lib/services/user-import-service";
import { adminActorOrResponse } from "../../users/route-utils";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

async function jobIdFrom(context: RouteContext) {
  return (await context.params).jobId;
}

function routeError(error: unknown) {
  if (error instanceof Error && /not found|未找到|不存在/i.test(error.message)) {
    return NextResponse.json({ message: error.message }, { status: 404 });
  }
  return badRequest(errorMessage(error));
}

export async function GET(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const preview = await createUserImportService(
      getAppRepository()
    ).rows(await jobIdFrom(context), auth.actor);
    return NextResponse.json(preview);
  } catch (error) {
    return routeError(error);
  }
}
