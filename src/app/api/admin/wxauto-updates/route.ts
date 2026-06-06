import { createWxautoUpdateService, MAX_INSTALLER_BYTES } from "@/lib/integrations/wxauto/update-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type UploadedInstaller = {
  name: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

function textField(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function installerField(value: FormDataEntryValue | null): UploadedInstaller | null {
  if (
    typeof value === "object"
    && value !== null
    && "name" in value
    && typeof value.name === "string"
    && "size" in value
    && typeof value.size === "number"
    && "arrayBuffer" in value
    && typeof value.arrayBuffer === "function"
  ) {
    return value as UploadedInstaller;
  }
  return null;
}

function unauthorized() {
  return Response.json({ message: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const expected = process.env.WXAUTO_UPDATE_PUBLISH_TOKEN;
  const actual = request.headers.get("x-update-publish-token");
  if (!expected || actual !== expected) return unauthorized();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ message: "Invalid multipart form data" }, { status: 400 });
  }

  const installer = installerField(form.get("installer"));
  if (!installer) return Response.json({ message: "Installer file is required" }, { status: 400 });
  if (installer.size > MAX_INSTALLER_BYTES) return Response.json({ message: "Installer exceeds 250 MiB" }, { status: 400 });
  if (!installer.name.toLowerCase().endsWith(".exe")) return Response.json({ message: "Installer must be an .exe file" }, { status: 400 });

  const version = textField(form, "version");
  const channel = textField(form, "channel") || "stable";
  const releaseNotes = textField(form, "releaseNotes");

  try {
    const bytes = new Uint8Array(await installer.arrayBuffer());
    const origin = new URL(request.url).origin;
    const release = await createWxautoUpdateService(undefined, { baseUrl: origin }).publish({
      version,
      channel,
      fileName: installer.name,
      releaseNotes,
      bytes
    });
    return Response.json({ release });
  } catch (error) {
    return Response.json({
      message: error instanceof Error ? error.message : "Failed to publish update"
    }, { status: 400 });
  }
}
