import { describe, expect, it } from "vitest";
import {
  claimOutboundInputSchema,
  completeOutboundInputSchema,
  registerAgentInputSchema,
  submitEventsInputSchema
} from "@/lib/integrations/wxauto/contracts";

describe("wxauto MCP contracts", () => {
  it("accepts one registered single-account Windows agent", () => {
    const result = registerAgentInputSchema.parse({
      deviceId: "device-a",
      displayName: "Front Desk PC",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11 23H2",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"]
    });

    expect(result.deviceId).toBe("device-a");
  });

  it("accepts ordered events with stable message ids", () => {
    const result = submitEventsInputSchema.parse({
      deviceId: "device-a",
      events: [
        {
          messageId: "wx-1",
          sequence: 1,
          conversationId: "现场群",
          conversationType: "group",
          senderName: "张三",
          text: "A01 网络断了",
          imageUrls: [],
          receivedAt: "2026-06-05T08:00:00.000Z"
        },
        {
          messageId: "wx-2",
          sequence: 2,
          conversationId: "现场群",
          conversationType: "group",
          senderName: "李四",
          text: "收到",
          imageUrls: [],
          receivedAt: "2026-06-05T08:00:01.000+00:00"
        }
      ]
    });

    expect(result.events.map((event) => event.messageId)).toEqual(["wx-1", "wx-2"]);
  });

  it("rejects events with a descending sequence", () => {
    const result = submitEventsInputSchema.safeParse({
      deviceId: "device-a",
      events: [
        {
          messageId: "wx-2",
          sequence: 2,
          conversationId: "现场群",
          conversationType: "group",
          senderName: "张三",
          receivedAt: "2026-06-05T08:00:01.000Z"
        },
        {
          messageId: "wx-1",
          sequence: 1,
          conversationId: "现场群",
          conversationType: "group",
          senderName: "张三",
          receivedAt: "2026-06-05T08:00:00.000Z"
        }
      ]
    });

    expect(result.success).toBe(false);
  });

  it("requires lease identity when completing outbound work", () => {
    expect(() => completeOutboundInputSchema.parse({
      deviceId: "device-a",
      messageId: "outbound-1",
      status: "sent",
      attemptedAt: "2026-06-05T08:00:00.000Z"
    })).toThrow();
  });

  it("parses claim limits and defaults to ten text messages", () => {
    expect(claimOutboundInputSchema.parse({ deviceId: "device-a" })).toEqual({
      deviceId: "device-a",
      limit: 10,
      supportedMessageTypes: ["text"]
    });
    expect(claimOutboundInputSchema.parse({ deviceId: "device-a", limit: 50 }).limit).toBe(50);
  });
});
