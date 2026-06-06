import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

const resultSchema = z.object({
  status: z.enum(["sent", "failed"]),
  error: z.string().optional()
});

function isAuthorized(request: Request, stateSecretEnv = "WECHAT_MCP_SECRET") {
  const expected = process.env[stateSecretEnv];
  if (!expected) return true;
  const headerSecret = request.headers.get("x-mcp-secret") ?? request.headers.get("x-wechat-mcp-secret");
  const authorization = request.headers.get("authorization");
  const actual = headerSecret ?? (authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined);
  return actual === expected;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ messageId: string }> }) {
  const { messageId } = await params;
  let input: z.infer<typeof resultSchema>;
  try {
    input = resultSchema.parse(await parseJson(request));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const repository = getAppRepository();
  const config = await repository.getConfig();
  const integration = config.messageIntegrations?.find((item) => item.channel === "wechat");
  if (!integration?.enabled) return badRequest("微信 MCP 接入未启用");
  if (!isAuthorized(request, integration.secretEnv)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });

  const message = await repository.completeLegacyOutbound(messageId, input.status, input.error);
  if (!message) {
    return NextResponse.json({ message: "出站消息不存在" }, { status: 404 });
  }

  return NextResponse.json({ message });
}
