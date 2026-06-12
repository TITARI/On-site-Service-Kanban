import { NextResponse } from "next/server";
import { z } from "zod";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { adminLogin, AuthServiceError } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

const loginSchema = z.object({
  phone: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(1024)
});

export async function POST(request: Request) {
  try {
    const parsed = loginSchema.safeParse(await parseJson(request));
    if (!parsed.success) {
      return NextResponse.json({ message: "手机号或密码不正确" }, { status: 401 });
    }
    const result = await adminLogin(
      getAppRepository(),
      parsed.data.phone,
      parsed.data.password
    );
    return NextResponse.json(
      { user: result.actor },
      { headers: { "Set-Cookie": result.cookie } }
    );
  } catch (error) {
    const status = error instanceof AuthServiceError ? error.status : 400;
    return NextResponse.json({ message: errorMessage(error) }, { status });
  }
}
