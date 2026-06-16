import { NextResponse } from "next/server";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import {
  UserImportValidationError,
  parseUserImportDecisionPatches
} from "@/lib/domain/user-import";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createUserImportService } from "@/lib/services/user-import-service";
import { adminActorOrResponse } from "../../../users/route-utils";

type RouteContext = {
  params: Promise<{ jobId: string }>;
};

async function jobIdFrom(context: RouteContext) {
  return (await context.params).jobId;
}

function routeError(error: unknown) {
  if (error instanceof UserImportValidationError) {
    return badRequest(error.message);
  }
  if (error instanceof Error && /not found/i.test(error.message)) {
    return NextResponse.json({ message: error.message }, { status: 404 });
  }
  if (
    error instanceof Error &&
    /blocked|confirmation.*required|action is not allowed/i.test(error.message)
  ) {
    return NextResponse.json({ message: error.message }, { status: 409 });
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

export async function PATCH(request: Request, context: RouteContext) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const body = await parseJson(request);
    if (!body || !Array.isArray(body.decisions)) {
      return badRequest("decisions must be an array");
    }
    const decisions = parseUserImportDecisionPatches(body.decisions);
    await createUserImportService(
      getAppRepository()
    ).saveDecisions(await jobIdFrom(context), decisions, auth.actor);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return routeError(error);
  }
}
