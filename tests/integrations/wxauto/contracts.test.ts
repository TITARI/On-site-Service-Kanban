import { describe, expect, it } from "vitest";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "@/lib/integrations/wxauto/contracts";

describe("wxauto MCP contracts", () => {
  it("accepts one registered single-account Windows agent", () => {
    expect(registerAgentInputSchema.parse({
      deviceId: "device-a",
      displayName: "Front Desk PC",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11 23H2",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"]
    }).deviceId).toBe("device-a");
  });

  it("requires ordered events with stable message ids", () => {
    expect(submitEventsInputSchema.parse({
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "site-group",
        conversationType: "group",
        senderName: "张三",
        text: "A01 网络断了",
        imageUrls: [],
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    }).events[0].messageId).toBe("wx-1");

    expect(() => submitEventsInputSchema.parse({
      deviceId: "device-a",
      events: [
        { messageId: "wx-2", sequence: 2, conversationId: "site-group", senderName: "张三", receivedAt: "2026-06-05T08:00:00.000Z" },
        { messageId: "wx-1", sequence: 1, conversationId: "site-group", senderName: "张三", receivedAt: "2026-06-05T08:00:01.000Z" }
      ]
    })).toThrow();
  });

  it("requires lease identity when completing outbound work", () => {
    expect(() => completeOutboundInputSchema.parse({
      deviceId: "device-a",
      messageId: "outbound-1",
      status: "sent",
      attemptedAt: "2026-06-05T08:00:00.000Z"
    })).toThrow();

    expect(claimOutboundInputSchema.parse({ deviceId: "device-a", limit: 10 }).limit).toBe(10);
  });
});
