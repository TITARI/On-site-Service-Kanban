import { NextResponse } from "next/server";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  saveUserImportDecisions,
  userImportErrorStatus
} from "@/lib/services/user-import-service";

type Context = { params: Promise<{ jobId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { jobId } = await params;
  try {
    const job = await saveUserImportDecisions(
      getAppRepository(),
      jobId,
      await parseJson(request),
      auth.actor
    );
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userImportErrorStatus(error) }
    );
  }
}
