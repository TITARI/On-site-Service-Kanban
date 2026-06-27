import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const registerAgentInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(160),
  appVersion: z.string().min(1).max(64),
  workerVersion: z.string().min(1).max(64),
  windowsVersion: z.string().min(1).max(160),
  wechatProcessState: z.enum(["running", "not_running", "unknown"]),
  wechatLoginState: z.enum(["logged_in", "logged_out", "unknown"]),
  safetyMode: z.literal("strict"),
  capabilities: z.array(z.enum(["text", "image"])).min(1)
});

export const registerAgentOutputSchema = z.object({
  deviceId: z.string(),
  serverTime: isoDateTime,
  minimumAppVersion: z.string(),
  recommendedPollIntervalMs: z.number().int().positive(),
  integrationEnabled: z.boolean()
});

export const wechatEventSchema = z.object({
  messageId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  conversationId: z.string().min(1).max(200),
  conversationType: z.enum(["direct", "group"]).default("direct"),
  senderId: z.string().max(160).optional(),
  senderName: z.string().min(1).max(160),
  text: z.string().default(""),
  imageUrls: z.array(z.string()).default([]),
  receivedAt: isoDateTime,
  operatorInitiated: z.boolean().optional()
}).passthrough();

export const submitEventsInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  events: z.array(wechatEventSchema).min(1).max(50)
}).superRefine(({ events }, context) => {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence <= events[index - 1].sequence) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "sequence"],
        message: "events must be ordered by increasing sequence"
      });
    }
  }
});

export const eventReceiptSchema = z.object({
  messageId: z.string(),
  action: z.enum(["ignored", "prompted", "registered", "processed", "duplicate", "error"]),
  inboundMessageId: z.string().optional()
});

export const claimOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(50).default(10),
  supportedMessageTypes: z.array(z.literal("text")).default(["text"])
});

export const outboundLeaseSchema = z.object({
  messageId: z.string(),
  leaseId: z.string(),
  leaseExpiresAt: isoDateTime,
  targetName: z.string(),
  targetConversationId: z.string().optional(),
  text: z.string(),
  createdAt: isoDateTime
});

export const completeOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(160),
  leaseId: z.string().min(1).max(160),
  status: z.enum(["sent", "failed", "blocked_by_safety_policy"]),
  error: z.string().max(1000).optional(),
  errorMessage: z.string().max(1000).optional(),
  safetyRule: z.string().max(160).optional(),
  attemptedAt: isoDateTime
});

export type RegisterAgentInput = z.infer<typeof registerAgentInputSchema>;
export type AgentRegistrationResult = z.infer<typeof registerAgentOutputSchema>;
export type WechatEventInput = z.infer<typeof wechatEventSchema>;
export type SubmitEventsInput = z.infer<typeof submitEventsInputSchema>;
export type EventReceipt = z.infer<typeof eventReceiptSchema>;
export type ClaimOutboundInput = z.infer<typeof claimOutboundInputSchema>;
export type OutboundLease = z.infer<typeof outboundLeaseSchema>;
export type CompleteOutboundInput = z.infer<typeof completeOutboundInputSchema>;
