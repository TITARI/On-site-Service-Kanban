import { getAppRepository, type AppRepository } from "@/lib/repositories/app-repository";
import type { IntakeMessageInput } from "@/lib/services/message-intake-service";
import type { WatchtowerAction } from "@/lib/services/wechat-watchtower-service";
import type { OutboundMessage } from "@/lib/domain/types";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema,
  type AgentRegistrationResult,
  type ClaimOutboundInput,
  type CompleteOutboundInput,
  type EventReceipt,
  type OutboundLease,
  type RegisterAgentInput,
  type SubmitEventsInput,
  type WechatEventInput
} from "./contracts";

const DEFAULT_LEASE_MS = 120000;

function isWechatIntegrationEnabled(config: Awaited<ReturnType<AppRepository["getConfig"]>>) {
  return Boolean(config.messageIntegrations?.find((item) => item.channel === "wechat")?.enabled);
}

function eventToIntakeInput(event: WechatEventInput): IntakeMessageInput {
  return {
    channel: "wechat",
    externalMessageId: event.messageId,
    senderId: event.senderId,
    senderName: event.senderName,
    senderGroup: event.conversationType === "group" ? event.conversationId : undefined,
    sourceConversationId: event.conversationId,
    text: event.text,
    imageUrls: event.imageUrls,
    receivedAt: event.receivedAt,
    raw: event
  };
}

function receiptFor(messageId: string, action: WatchtowerAction, inboundMessageId?: string): EventReceipt {
  return { messageId, action, inboundMessageId };
}

function leaseExpiry(message: OutboundMessage) {
  const basis = message.claimedAt ?? new Date().toISOString();
  return new Date(new Date(basis).getTime() + DEFAULT_LEASE_MS).toISOString();
}

function messageToLease(message: OutboundMessage): OutboundLease {
  return {
    messageId: message.id,
    leaseId: message.id,
    leaseExpiresAt: leaseExpiry(message),
    targetName: message.targetName,
    targetConversationId: message.targetConversationId,
    text: message.text,
    createdAt: message.createdAt
  };
}

function completionError(input: CompleteOutboundInput) {
  if (input.status === "blocked_by_safety_policy") {
    return input.errorMessage ?? input.error ?? input.safetyRule ?? "Blocked by desktop safety policy";
  }
  return input.errorMessage ?? input.error;
}

export function createWxautoIntegrationService(repository: AppRepository = getAppRepository()) {
  return {
    async registerAgent(input: unknown): Promise<AgentRegistrationResult> {
      const agent: RegisterAgentInput = registerAgentInputSchema.parse(input);
      const config = await repository.getConfig();
      return {
        deviceId: agent.deviceId,
        serverTime: new Date().toISOString(),
        minimumAppVersion: "0.1.0",
        recommendedPollIntervalMs: 2000,
        integrationEnabled: isWechatIntegrationEnabled(config)
      };
    },

    async submitEvents(input: unknown): Promise<{ receipts: EventReceipt[] }> {
      const payload: SubmitEventsInput = submitEventsInputSchema.parse(input);
      const receipts: EventReceipt[] = [];
      for (const event of payload.events) {
        const result = await repository.processWechatMessage(eventToIntakeInput(event));
        receipts.push(receiptFor(event.messageId, result.action, result.record?.id));
      }
      return { receipts };
    },

    async claimOutbound(input: unknown): Promise<{ messages: OutboundLease[] }> {
      const payload: ClaimOutboundInput = claimOutboundInputSchema.parse(input);
      await repository.runAutoAcceptance();
      const messages = await repository.claimOutboundMessages(payload.limit);
      return { messages: messages.map(messageToLease) };
    },

    async completeOutbound(input: unknown): Promise<{ accepted: boolean }> {
      const payload: CompleteOutboundInput = completeOutboundInputSchema.parse(input);
      const status = payload.status === "sent" ? "sent" : "failed";
      const message = await repository.markOutboundMessage(payload.messageId, status, completionError(payload));
      return { accepted: Boolean(message) };
    }
  };
}
