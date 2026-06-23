import { NextResponse } from "next/server";
import { z } from "zod";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { isWechatRequestAuthorized } from "@/lib/integrations/wechat/auth";
import { getAppRepository } from "@/lib/repositories/app-repository";
import type { IntakeMessageInput } from "@/lib/services/message-intake-service";

const messageSchema = z.object({
  channel: z.enum(["wechat", "wecom"]),
}).passthrough();

function pickString(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pickImages(raw: Record<string, unknown>) {
  const value = raw.imageUrls ?? raw.images ?? raw.image_urls;
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null && "url" in item && typeof item.url === "string") return item.url;
      return undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function normalizePayload(raw: z.infer<typeof messageSchema>): IntakeMessageInput {
  const record = raw as Record<string, unknown>;
  return {
    channel: raw.channel,
    externalMessageId: pickString(record, ["externalMessageId", "msgId", "messageId", "id"]),
    senderId: pickString(record, ["senderId", "fromUserId", "fromUser", "userId"]),
    senderName: pickString(record, ["senderName", "fromName", "nickname", "name"]),
    senderPhone: pickString(record, ["senderPhone", "mobile", "phone", "tel"]),
    senderGroup: pickString(record, ["senderGroup", "groupName", "roomName", "chatName"]),
    sourceConversationId: pickString(record, ["sourceConversationId", "conversationId", "roomId", "chatId"]),
    text: pickString(record, ["text", "content", "message", "body"]),
    imageUrls: pickImages(record),
    receivedAt: pickString(record, ["receivedAt", "createTime", "timestamp"]),
    raw: record
  };
}

export async function POST(request: Request) {
  const repository = getAppRepository();
  let body: IntakeMessageInput;

  try {
    body = normalizePayload(messageSchema.parse(await parseJson(request)));
  } catch (error) {
    return badRequest(errorMessage(error));
  }

  const config = await repository.getConfig();
  const integration = config.messageIntegrations?.find((item) => item.channel === body.channel);
  if (!integration?.enabled) return badRequest("微信/企微 MCP 接入未启用");
  if (!isWechatRequestAuthorized(request, integration.secretEnv)) return NextResponse.json({ message: "MCP 密钥校验失败" }, { status: 401 });

  const result = await repository.processWechatMessage(body);
  return NextResponse.json(result);
}
