import { NextResponse } from "next/server";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { requireRequestActor } from "@/lib/services/auth-service";
import { mergeConfigSecrets, stripConfigSecrets, validateConfig } from "@/lib/services/config-service";

export async function GET(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
  const config = await getAppRepository().getConfig();
  return NextResponse.json({ config: stripConfigSecrets(config) });
}

export async function PUT(request: Request) {
  const auth = await requireRequestActor(request, "admin", "admin.access");
  if (!auth.ok) return auth.response;
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
