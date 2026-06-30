import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { isWechatRequestAuthorized } from "@/lib/integrations/wechat/auth";
import { enqueueOutboundMessages } from "@/lib/queue/outbound-queue";
import { getAppRepository } from "@/lib/repositories/app-repository";

const claimSchema = z.object({ limit: z.number().int().min(1).max(50).default(10) });

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
  if (!isWechatRequestAuthorized(request, integration.secretEnv)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });

  await repository.runAutoAcceptance();
  const messages = await repository.claimOutboundMessages(input.limit);
  try {
    const queued = await enqueueOutboundMessages(messages);
    return NextResponse.json({ messages: [], queued });
  } catch (error) {
    console.error("[wechat-outbound] BullMQ dispatch failed", error);
    return NextResponse.json({ message: "出站队列暂不可用" }, { status: 503 });
  }
}
