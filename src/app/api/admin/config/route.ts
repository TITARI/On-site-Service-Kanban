import { NextResponse } from "next/server";
import { requireAdminAccess } from "@/lib/api/admin-guard";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { mergeConfigSecrets, stripConfigSecrets, validateConfig } from "@/lib/services/config-service";

export async function GET(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  const config = await getAppRepository().getConfig();
  return NextResponse.json({ config: stripConfigSecrets(config) });
}

export async function PUT(request: Request) {
  const unauthorized = await requireAdminAccess(request);
  if (unauthorized) return unauthorized;

  const repository = getAppRepository();
  let config: ReturnType<typeof validateConfig>;
  try {
    const incoming = await parseJson(request) as ReturnType<typeof validateConfig>;
    const existing = await repository.getConfig();
    config = validateConfig(mergeConfigSecrets(incoming, existing));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const saved = await repository.saveConfig(config);
  return NextResponse.json({ config: stripConfigSecrets(saved) });
}
