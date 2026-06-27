import type { AppState } from "../domain/app-state";
import type { MessageChannel, OutboundMessage, Ticket } from "../domain/types";

export type QueueOutboundMessageInput = {
  channel: MessageChannel;
  targetConversationId?: string;
  targetChatIdentityId?: string;
  targetName: string;
  text: string;
  relatedTicketId?: string;
  relatedSessionId?: string;
};

function now() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function outboundMessagesOf(state: AppState) {
  state.outboundMessages ??= [];
  return state.outboundMessages;
}

export function queueOutboundMessage(state: AppState, input: QueueOutboundMessageInput): OutboundMessage {
  const createdAt = now();
  const message: OutboundMessage = {
    id: id("outbound"),
    channel: input.channel,
    targetConversationId: input.targetConversationId,
    targetChatIdentityId: input.targetChatIdentityId,
    targetName: input.targetName,
    text: input.text.trim(),
    relatedTicketId: input.relatedTicketId,
    relatedSessionId: input.relatedSessionId,
    status: "pending",
    retryCount: 0,
    createdAt,
    updatedAt: createdAt
  };
  outboundMessagesOf(state).push(message);
  return message;
}

export function claimPendingOutboundMessages(
  state: AppState,
  { limit = 10, now: nowIso = now(), claimTimeoutMs = 120000 }: { limit?: number; now?: string; claimTimeoutMs?: number } = {}
) {
  const nowMs = new Date(nowIso).getTime();
  const messages = outboundMessagesOf(state)
    .filter((message) => {
      if (message.status === "pending") return true;
      if (message.status === "failed") return message.retryCount < 3;
      if (message.status !== "sending" || !message.claimedAt) return false;
      return nowMs - new Date(message.claimedAt).getTime() >= claimTimeoutMs;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, limit);

  for (const message of messages) {
    message.status = "sending";
    message.claimedAt = nowIso;
    message.updatedAt = nowIso;
  }

  return messages;
}

export function markOutboundMessageSent(state: AppState, messageId: string, nowIso = now()) {
  const message = outboundMessagesOf(state).find((item) => item.id === messageId);
  if (!message) throw new Error("出站消息不存在");
  if (message.status === "sent") return message;
  message.status = "sent";
  message.sentAt = nowIso;
  message.lastError = undefined;
  message.updatedAt = nowIso;
  return message;
}

export function markOutboundMessageFailed(state: AppState, messageId: string, error: string, nowIso = now()) {
  const message = outboundMessagesOf(state).find((item) => item.id === messageId);
  if (!message) throw new Error("出站消息不存在");
  if (message.status === "sent") return message;
  message.status = "failed";
  message.retryCount += 1;
  message.lastError = error.trim() || "发送失败";
  message.updatedAt = nowIso;
  return message;
}

function conversationTargetForTicket(state: AppState, ticket: Ticket) {
  if (ticket.sourceConversationId) return ticket.sourceConversationId;
  const identity = state.chatIdentities?.find((item) => item.id === ticket.reporterChatIdentityId);
  if (identity?.displayName) return identity.displayName;
  return ticket.submitterName;
}

export function queueTicketFeedbackMessage(state: AppState, ticket: Ticket, text: string) {
  return queueOutboundMessage(state, {
    channel: "wechat",
    targetConversationId: ticket.sourceConversationId,
    targetChatIdentityId: ticket.reporterChatIdentityId,
    targetName: conversationTargetForTicket(state, ticket),
    text,
    relatedTicketId: ticket.id
  });
}

export function queueProcessingGroupMessage(state: AppState, ticket: Ticket, text: string) {
  const groupConversation = (state.config.processingGroupConversations ?? []).find(
    (conversation) => conversation.groupId === ticket.assignmentGroup
  );
  const targetName = ticket.assignmentGroup ?? ticket.handlerName ?? "处理组";
  return queueOutboundMessage(state, {
    channel: "wechat",
    targetConversationId: groupConversation?.wechatConversationId,
    targetName,
    text,
    relatedTicketId: ticket.id
  });
}

export function queueAdminMessage(state: AppState, ticket: Ticket, text: string) {
  return queueOutboundMessage(state, {
    channel: "wechat",
    targetName: "管理员",
    text,
    relatedTicketId: ticket.id
  });
}
