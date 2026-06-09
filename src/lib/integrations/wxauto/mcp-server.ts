import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  eventReceiptSchema,
  outboundLeaseSchema,
  registerAgentInputSchema,
  registerAgentOutputSchema,
  submitEventsInputSchema
} from "./contracts";
import { createWxautoIntegrationService } from "./service";

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value
  };
}

export function createWxautoMcpServer() {
  const service = createWxautoIntegrationService();
  const server = new McpServer({ name: "main-board-wxauto", version: "1.0.0" });

  server.registerTool("register_wxauto_agent", {
    description: "Register or refresh a wxauto desktop agent.",
    inputSchema: registerAgentInputSchema,
    outputSchema: registerAgentOutputSchema,
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => toolResult(await service.registerAgent(input)));

  server.registerTool("submit_wechat_events", {
    description: "Submit an ordered batch of inbound WeChat events.",
    inputSchema: submitEventsInputSchema,
    outputSchema: z.object({ receipts: z.array(eventReceiptSchema) }),
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => toolResult(await service.submitEvents(input)));

  server.registerTool("claim_outbound_messages", {
    description: "Lease pending outbound WeChat messages for one desktop agent.",
    inputSchema: claimOutboundInputSchema,
    outputSchema: z.object({ messages: z.array(outboundLeaseSchema) }),
    annotations: { idempotentHint: false, openWorldHint: false }
  }, async (input) => toolResult(await service.claimOutbound(input)));

  server.registerTool("complete_outbound_message", {
    description: "Complete a leased outbound message with sent, failed, or safety-blocked status.",
    inputSchema: completeOutboundInputSchema,
    outputSchema: z.object({ accepted: z.boolean() }),
    annotations: { idempotentHint: true, openWorldHint: false }
  }, async (input) => toolResult(await service.completeOutbound(input)));

  return server;
}
