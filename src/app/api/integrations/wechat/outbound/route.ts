import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";

const claimSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) });

function isAuthorized(request: Request, stateSecretEnv = "WECHAT_MCP_SECRET") {
  const expected = process.env[stateSecretEnv];
  if (!expected) return true;
  const headerSecret = request.headers.get("x-mcp-secret") ?? request.headers.get("x-wechat-mcp-secret");
  const authorization = request.headers.get("authorization");
  const actual = headerSecret ?? (authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined);
  return actual === expected;
}

export async function POST(request: Request) {
  let input: z.infer<typeof claimSchema>;
  try {
    input = claimSchema.parse(await parseJson(request));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const repository = getAppRepository();
  const config = await repository.getConfig();
  const integration = config.messageIntegrations?.find((item) => item.channel === "wechat");
  if (!integration?.enabled) return badRequest("微信 MCP 接入未启用");
  if (!isAuthorized(request, integration.secretEnv)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });

  await repository.runAutoAcceptance();
  const messages = await repository.claimOutboundMessages(input.limit);
  return NextResponse.json({ messages });
}
