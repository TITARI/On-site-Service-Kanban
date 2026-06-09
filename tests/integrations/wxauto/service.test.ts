import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { createWxautoIntegrationService } from "@/lib/integrations/wxauto/service";
import { defaultConfig } from "@/lib/seed";

const repository = {
  runAutoAcceptance: vi.fn(),
  getConfig: vi.fn(),
  processWechatMessage: vi.fn(),
  claimOutboundMessages: vi.fn(),
  markOutboundMessage: vi.fn()
} as unknown as AppRepository & {
  runAutoAcceptance: ReturnType<typeof vi.fn>;
  getConfig: ReturnType<typeof vi.fn>;
  processWechatMessage: ReturnType<typeof vi.fn>;
  claimOutboundMessages: ReturnType<typeof vi.fn>;
  markOutboundMessage: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  repository.runAutoAcceptance.mockReset().mockResolvedValue(undefined);
  repository.getConfig.mockReset().mockResolvedValue({
    ...defaultConfig(),
    wxautoMcp: { enabled: true, endpoint: "/api/mcp", accessToken: "test-token", autoCreateTickets: false },
    messageIntegrations: [
      { id: "wechat", channel: "wechat", label: "wxauto 桌面服务", enabled: true, mcpServerName: "wxauto-desktop", endpoint: "/api/mcp", secretEnv: "WXAUTO_MCP_TOKEN", autoCreateTickets: false }
    ]
  });
  repository.processWechatMessage.mockReset().mockResolvedValue({
    action: "processed",
    record: { id: "message-1" }
  });
  repository.claimOutboundMessages.mockReset().mockResolvedValue([{
    id: "outbound-1",
    channel: "wechat",
    targetName: "现场群",
    targetConversationId: "conv-site",
    text: "已创建工单",
    status: "sending",
    retryCount: 0,
    claimedAt: "2026-06-05T08:00:00.000Z",
    createdAt: "2026-06-05T07:59:00.000Z",
    updatedAt: "2026-06-05T08:00:00.000Z"
  }]);
  repository.markOutboundMessage.mockReset().mockResolvedValue({ id: "outbound-1" });
});

describe("wxauto integration service", () => {
  it("reports registration state from existing board config", async () => {
    const result = await createWxautoIntegrationService(repository).registerAgent({
      deviceId: "device-a",
      displayName: "PC",
      appVersion: "0.1.0",
      workerVersion: "0.1.0",
      windowsVersion: "Windows 11",
      wechatProcessState: "running",
      wechatLoginState: "logged_in",
      safetyMode: "strict",
      capabilities: ["text"]
    });

    expect(result).toMatchObject({ deviceId: "device-a", integrationEnabled: true });
  });

  it("maps inbound events into the existing watchtower intake path", async () => {
    const result = await createWxautoIntegrationService(repository).submitEvents({
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "conv-site",
        conversationType: "group",
        senderId: "wxid-a",
        senderName: "张三",
        text: "A01 网络断了",
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    });

    expect(result.receipts).toEqual([{ messageId: "wx-1", action: "processed", inboundMessageId: "message-1" }]);
    expect(repository.processWechatMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "wechat",
      externalMessageId: "wx-1",
      senderGroup: "conv-site",
      sourceConversationId: "conv-site"
    }));
  });

  it("leases outbound messages and completes safety-blocked attempts as failed", async () => {
    const service = createWxautoIntegrationService(repository);

    const claim = await service.claimOutbound({ deviceId: "device-a", limit: 5 });
    expect(claim.messages[0]).toMatchObject({
      messageId: "outbound-1",
      leaseId: "outbound-1",
      targetName: "现场群",
      text: "已创建工单"
    });
    expect(repository.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(repository.claimOutboundMessages).toHaveBeenCalledWith(5);

    const complete = await service.completeOutbound({
      deviceId: "device-a",
      messageId: "outbound-1",
      leaseId: "outbound-1",
      status: "blocked_by_safety_policy",
      errorMessage: "no target",
      attemptedAt: "2026-06-05T08:00:10.000Z"
    });
    expect(complete.accepted).toBe(true);
    expect(repository.markOutboundMessage).toHaveBeenCalledWith("outbound-1", "failed", "no target");
  });
});
