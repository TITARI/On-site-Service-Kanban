import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema,
  type AgentRegistrationResult,
  type EventReceipt,
  type OutboundLease
} from "./contracts";
import { createWxautoIntegrationService } from "./service";

type WxautoIntegrationService = ReturnType<typeof createWxautoIntegrationService>;

const isoDateTime = z.string().datetime({ offset: true });

const agentRegistrationOutputSchema = z.object({
  deviceId: z.string(),
  serverTime: isoDateTime,
  minimumAppVersion: z.string(),
  recommendedPollIntervalMs: z.number().int().nonnegative(),
  integrationEnabled: z.boolean()
});

const eventReceiptOutputSchema = z.object({
  messageId: z.string(),
  action: z.enum(["ignored", "prompted", "registered", "processed", "duplicate"]),
  inboundMessageId: z.string().optional()
});

const outboundLeaseOutputSchema = z.object({
  messageId: z.string(),
  leaseId: z.string(),
  leaseExpiresAt: isoDateTime,
  targetName: z.string(),
  targetConversationId: z.string().optional(),
  text: z.string(),
  createdAt: isoDateTime
});

const submitEventsOutputSchema = z.object({
  receipts: z.array(eventReceiptOutputSchema)
});

const claimOutboundOutputSchema = z.object({
  messages: z.array(outboundLeaseOutputSchema)
});

const outboundMessageOutputSchema = z.object({
  id: z.string(),
  channel: z.enum(["wechat", "wecom"]),
  targetConversationId: z.string().optional(),
  targetChatIdentityId: z.string().optional(),
  targetName: z.string(),
  text: z.string(),
  relatedTicketId: z.string().optional(),
  relatedSessionId: z.string().optional(),
  status: z.enum(["pending", "sending", "sent", "failed", "blocked"]),
  retryCount: z.number().int().nonnegative(),
  lastError: z.string().optional(),
  claimedAt: isoDateTime.optional(),
  claimedByAgentId: z.string().optional(),
  leaseId: z.string().optional(),
  leaseExpiresAt: isoDateTime.optional(),
  safetyRule: z.string().optional(),
  sentAt: isoDateTime.optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
});

const completeOutboundOutputSchema = z.object({
  accepted: z.boolean(),
  message: outboundMessageOutputSchema.optional()
});

function toolResult<T extends Record<string, unknown>>(structuredContent: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent
  };
}

export function createWxautoMcpServer(service: WxautoIntegrationService = createWxautoIntegrationService()) {
  const server = new McpServer({
    name: "wxauto-mcp",
    version: "0.1.0"
  });

  server.registerTool("register_wxauto_agent", {
    title: "Register wxauto agent",
    description: "Register a wxauto desktop agent and fetch integration policy.",
    inputSchema: registerAgentInputSchema,
    outputSchema: agentRegistrationOutputSchema
  }, async (input) => {
    const result: AgentRegistrationResult = await service.registerAgent(input);
    return toolResult(result);
  });

  server.registerTool("submit_wechat_events", {
    title: "Submit WeChat events",
    description: "Submit observed WeChat messages from the wxauto agent.",
    inputSchema: submitEventsInputSchema,
    outputSchema: submitEventsOutputSchema
  }, async (input) => {
    const receipts: EventReceipt[] = await service.submitEvents(input);
    return toolResult({ receipts });
  });

  server.registerTool("claim_outbound_messages", {
    title: "Claim outbound messages",
    description: "Claim pending outbound WeChat messages for safe delivery.",
    inputSchema: claimOutboundInputSchema,
    outputSchema: claimOutboundOutputSchema
  }, async (input) => {
    const messages: OutboundLease[] = await service.claimOutbound(input);
    return toolResult({ messages });
  });

  server.registerTool("complete_outbound_message", {
    title: "Complete outbound message",
    description: "Complete a previously claimed outbound message lease.",
    inputSchema: completeOutboundInputSchema,
    outputSchema: completeOutboundOutputSchema
  }, async (input) => {
    const result = await service.completeOutbound(input);
    return toolResult(result);
  });

  return server;
}
