import { NextResponse } from "next/server";
import { errorMessage } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  getUserImportJob,
  userImportErrorStatus
} from "@/lib/services/user-import-service";

type Context = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Context) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const { jobId } = await params;
  try {
    return NextResponse.json(
      await getUserImportJob(getAppRepository(), jobId, auth.actor)
    );
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userImportErrorStatus(error) }
    );
  }
}
