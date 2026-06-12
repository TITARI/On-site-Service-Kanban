import { NextResponse } from "next/server";
import type { SessionType } from "@/lib/domain/access-control";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { resolveRequestActor } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestedType = new URL(request.url).searchParams.get("type");
  if (requestedType !== "mobile" && requestedType !== "admin") {
    return NextResponse.json({ message: "会话类型无效" }, { status: 400 });
  }
  const type: SessionType = requestedType;
  const repository = getAppRepository();
  const auth = await resolveRequestActor(repository, request, type);
  if (auth.ok) return NextResponse.json({ authenticated: true, user: auth.actor });
  if (type === "admin") {
    const bootstrap = await repository.bootstrapStatus();
    return NextResponse.json({
      authenticated: false,
      bootstrapRequired: bootstrap.required
    });
  }
  return NextResponse.json({ authenticated: false });
}
