import { NextResponse } from "next/server";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { parseMasterDataRows } from "@/lib/domain/master-data";
import { getAppRepository } from "@/lib/repositories/app-repository";

function requestBody(value: unknown) {
  return typeof value === "object" && value !== null ? value as { rows?: unknown; dryRun?: unknown } : {};
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await parseJson(request);
  } catch (error) {
    return badRequest(errorMessage(error));
  }
  const payload = requestBody(body);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const dryRun = Boolean(payload.dryRun);
  const result = parseMasterDataRows(rows);
  if (result.errors.length > 0) return NextResponse.json(result, { status: 400 });
  if (dryRun) return NextResponse.json(result);

  const booths = await getAppRepository().importBooths(result.records);
  return NextResponse.json({ ...result, booths });
}
