import { NextResponse } from "next/server";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import {
  previewUserImport,
  userImportErrorStatus
} from "@/lib/services/user-import-service";

export async function POST(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  try {
    const job = await previewUserImport(
      getAppRepository(),
      await parseJson(request),
      auth.actor
    );
    return NextResponse.json(job, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { message: errorMessage(error) },
      { status: userImportErrorStatus(error) }
    );
  }
}
