import { NextResponse } from "next/server";
import { z } from "zod";
import { errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { AuthServiceError, bootstrapFirstAdmin } from "@/lib/services/auth-service";

export const dynamic = "force-dynamic";

const groupSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("existing"),
    groupId: z.string().trim().min(1).max(64)
  }),
  z.object({
    mode: z.literal("create"),
    name: z.string().trim().min(1).max(120)
  })
]);

const bootstrapSchema = z.object({
  legacyPassword: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(1).max(32),
  password: z.string().min(10).max(1024),
  group: groupSchema
});

export async function POST(request: Request) {
  try {
    const parsed = bootstrapSchema.safeParse(await parseJson(request));
    if (!parsed.success) {
      return NextResponse.json(
        { message: "初始化信息不完整", details: parsed.error.flatten() },
        { status: 400 }
      );
    }
    const result = await bootstrapFirstAdmin(
      getAppRepository(),
      parsed.data,
      { ADMIN_BOOTSTRAP_PASSWORD: process.env.ADMIN_BOOTSTRAP_PASSWORD }
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
