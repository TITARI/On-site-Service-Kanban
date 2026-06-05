import { z } from "zod";

const isoDateTime = z.string().datetime({ offset: true });

export const registerAgentInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(160),
  appVersion: z.string().min(1).max(64),
  workerVersion: z.string().min(1).max(64),
  windowsVersion: z.string().min(1).max(120),
  wechatProcessState: z.enum(["running", "not_running", "unknown"]),
  wechatLoginState: z.enum(["logged_in", "logged_out", "unknown"]),
  safetyMode: z.literal("strict"),
  capabilities: z.array(z.enum(["text", "image"])).min(1)
});

export const wechatEventSchema = z.object({
  messageId: z.string().min(1).max(160),
  sequence: z.number().int().nonnegative(),
  conversationId: z.string().min(1).max(160),
  conversationType: z.enum(["direct", "group"]),
  senderId: z.string().max(160).optional(),
  senderName: z.string().min(1).max(160),
  text: z.string().default(""),
  imageUrls: z.array(z.string()).default([]),
  receivedAt: isoDateTime
});

export const submitEventsInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  events: z.array(wechatEventSchema).min(1).max(50)
}).superRefine(({ events }, context) => {
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].sequence <= events[index - 1].sequence) {
      context.addIssue({
        code: "custom",
        path: ["events", index, "sequence"],
        message: "events must be ordered"
      });
    }
  }
});

export const claimOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  limit: z.number().int().min(1).max(50).default(10),
  supportedMessageTypes: z.array(z.literal("text")).default(["text"])
});

export const completeOutboundInputSchema = z.object({
  deviceId: z.string().min(1).max(128),
  messageId: z.string().min(1).max(64),
  leaseId: z.string().min(1).max(64),
  status: z.enum(["sent", "failed", "blocked_by_safety_policy"]),
  error: z.string().max(1000).optional(),
  safetyRule: z.string().max(120).optional(),
  attemptedAt: isoDateTime
});

export type RegisterAgentInput = z.infer<typeof registerAgentInputSchema>;
export type WechatEventInput = z.infer<typeof wechatEventSchema>;
export type SubmitEventsInput = z.infer<typeof submitEventsInputSchema>;
export type ClaimOutboundInput = z.infer<typeof claimOutboundInputSchema>;
export type CompleteOutboundInput = z.infer<typeof completeOutboundInputSchema>;

export type AgentRegistrationResult = {
  deviceId: string;
  serverTime: string;
  minimumAppVersion: string;
  recommendedPollIntervalMs: number;
  integrationEnabled: boolean;
};

export type EventReceipt = {
  messageId: string;
  action: "ignored" | "prompted" | "registered" | "processed" | "duplicate";
  inboundMessageId?: string;
};

export type OutboundLease = {
  messageId: string;
  leaseId: string;
  leaseExpiresAt: string;
  targetName: string;
  targetConversationId?: string;
  text: string;
  createdAt: string;
};
