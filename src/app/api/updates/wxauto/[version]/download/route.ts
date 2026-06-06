import { readFile } from "node:fs/promises";
import { defaultWxautoUpdateRoot, resolveSafeInstallerPath } from "@/lib/integrations/wxauto/update-service";
import { getAppRepository } from "@/lib/repositories/app-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string }> }
) {
  const { version } = await params;
  const release = await getAppRepository().getWxautoRelease(version);
  if (!release) return Response.json({ message: "Release not found" }, { status: 404 });

  const filePath = resolveSafeInstallerPath(defaultWxautoUpdateRoot(), release.filePath);
  if (!filePath) return Response.json({ message: "Release not found" }, { status: 404 });

  try {
    const bytes = await readFile(filePath);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new Response(body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${release.fileName.replaceAll("\"", "")}"`,
        "Content-Length": String(bytes.byteLength),
        "X-Content-SHA256": release.sha256
      }
    });
  } catch {
    return Response.json({ message: "Release not found" }, { status: 404 });
  }
}
