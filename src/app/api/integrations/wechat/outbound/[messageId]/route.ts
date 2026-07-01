import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { isWechatRequestAuthorized } from "@/lib/integrations/wechat/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";

const resultSchema = z.object({
  status: z.enum(["sent", "failed"]),
  error: z.string().optional(),
  attemptsMade: z.number().int().min(1).optional()
});

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
  if (!isWechatRequestAuthorized(request, integration.secretEnv)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });

  const message = await repository.markOutboundMessage(messageId, input.status, input.error, input.attemptsMade);
  if (!message) {
    return NextResponse.json({ message: "出站消息不存在" }, { status: 404 });
  }

  return NextResponse.json({ message });
}
