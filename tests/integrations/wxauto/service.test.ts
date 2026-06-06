import { describe, expect, it, vi } from "vitest";
import { createWxautoIntegrationService } from "@/lib/integrations/wxauto/service";
import type { AppRepository } from "@/lib/repositories/app-repository";

function repository() {
  return {
    registerWxautoAgent: vi.fn(async (input) => ({
      deviceId: input.deviceId,
      serverTime: "2026-06-05T08:00:00.000Z",
      minimumAppVersion: "0.1.0",
      recommendedPollIntervalMs: 2000,
      integrationEnabled: true
    })),
    submitWxautoEvents: vi.fn(async () => [{ messageId: "wx-1", action: "processed" }]),
    claimWxautoOutbound: vi.fn(async () => [{
      messageId: "outbound-1",
      leaseId: "lease-1",
      leaseExpiresAt: "2026-06-05T08:02:00.000Z",
      targetName: "现场群",
      text: "工单已创建",
      createdAt: "2026-06-05T08:00:00.000Z"
    }]),
    completeWxautoOutbound: vi.fn(async () => ({ accepted: true }))
  } as unknown as AppRepository;
}

describe("wxauto integration service", () => {
  it("delegates parsed agent registration inputs to the repository", async () => {
    const repo = repository();
    const result = await createWxautoIntegrationService(repo).registerAgent({
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

    expect(result.deviceId).toBe("device-a");
    expect(repo.registerWxautoAgent).toHaveBeenCalledOnce();
  });

  it("rejects invalid transport inputs before calling the repository", async () => {
    const repo = repository();

    expect(() => createWxautoIntegrationService(repo).claimOutbound({
      deviceId: "device-a",
      limit: 999
    })).toThrow();
    expect(repo.claimWxautoOutbound).not.toHaveBeenCalled();
  });

  it("delegates submitted events, outbound claims, and completion", async () => {
    const repo = repository();
    const service = createWxautoIntegrationService(repo);

    await expect(service.submitEvents({
      deviceId: "device-a",
      events: [{
        messageId: "wx-1",
        sequence: 1,
        conversationId: "现场群",
        conversationType: "group",
        senderName: "张三",
        receivedAt: "2026-06-05T08:00:00.000Z"
      }]
    })).resolves.toEqual([{ messageId: "wx-1", action: "processed" }]);
    await expect(service.claimOutbound({ deviceId: "device-a", limit: 1 }))
      .resolves.toHaveLength(1);
    await expect(service.completeOutbound({
      deviceId: "device-a",
      messageId: "outbound-1",
      leaseId: "lease-1",
      status: "sent",
      attemptedAt: "2026-06-05T08:01:00.000Z"
    })).resolves.toEqual({ accepted: true });

    expect(repo.submitWxautoEvents).toHaveBeenCalledOnce();
    expect(repo.claimWxautoOutbound).toHaveBeenCalledOnce();
    expect(repo.completeWxautoOutbound).toHaveBeenCalledOnce();
  });
});
