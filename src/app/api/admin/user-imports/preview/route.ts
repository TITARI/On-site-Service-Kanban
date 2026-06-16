import { NextResponse } from "next/server";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { createUserImportService } from "@/lib/services/user-import-service";
import { adminActorOrResponse } from "../../users/route-utils";

export async function POST(request: Request) {
  const auth = await adminActorOrResponse(request);
  if ("response" in auth) return auth.response;

  try {
    const preview = await createUserImportService(
      getAppRepository()
    ).preview(await parseJson(request), auth.actor);
    return NextResponse.json(preview, { status: 201 });
  } catch (error) {
    return badRequest(errorMessage(error));
  }
}
