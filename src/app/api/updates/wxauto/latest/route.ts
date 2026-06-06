import { getAppRepository } from "@/lib/repositories/app-repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const channel = new URL(request.url).searchParams.get("channel")?.trim() || "stable";
  const releases = await getAppRepository().listWxautoReleases();
  const release = releases
    .filter((item) => item.channel === channel)
    .sort((left, right) => new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime())[0];

  if (!release || typeof release.manifest.payload !== "string") {
    return Response.json({ message: "No wxauto release found" }, { status: 404 });
  }

  return Response.json({
    payload: release.manifest.payload,
    signature: release.signature
  });
}
