import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { mobileLogin } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(32),
  groupId: z.string().trim().min(1).max(64)
});

export async function POST(request: Request) {
  try {
    const parsed = loginSchema.safeParse(await parseJson(request));
    if (!parsed.success) return badRequest("登录信息不完整", parsed.error.flatten());
    const result = await mobileLogin(getAppRepository(), parsed.data);
    return NextResponse.json(
      { user: result.actor },
      { headers: { "Set-Cookie": result.cookie } }
    );
  } catch (error) {
    return badRequest(errorMessage(error));
  }
}
