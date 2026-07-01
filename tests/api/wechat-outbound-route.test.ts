import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import {
  claimPendingOutboundMessages,
  markOutboundMessageFailed,
  markOutboundMessageSent,
  queueOutboundMessage
} from "@/lib/services/outbound-message-service";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  runAutoAcceptance: vi.fn(),
  getConfig: vi.fn(),
  claimOutboundMessages: vi.fn(),
  markOutboundMessage: vi.fn()
}));

const queue = vi.hoisted(() => ({
  enqueueOutboundMessages: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    getConfig: store.getConfig,
    claimOutboundMessages: store.claimOutboundMessages,
    markOutboundMessage: store.markOutboundMessage
  } as unknown as AppRepository)
}));

vi.mock("@/lib/queue/outbound-queue", () => ({
  enqueueOutboundMessages: queue.enqueueOutboundMessages
}));

const outboundRoute = await import("@/app/api/integrations/wechat/outbound/route");
const outboundResultRoute = await import("@/app/api/integrations/wechat/outbound/[messageId]/route");

function state(): AppState {
  return {
    booths: [],
    tickets: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: {
      ...defaultConfig(),
      messageIntegrations: [
        { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false }
      ]
    }
  };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/integrations/wechat/outbound", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  store.state = state();
  store.runAutoAcceptance.mockReset();
  store.getConfig.mockReset();
  store.claimOutboundMessages.mockReset();
  store.markOutboundMessage.mockReset();
  queue.enqueueOutboundMessages.mockReset();
  store.runAutoAcceptance.mockResolvedValue(undefined);
  store.getConfig.mockImplementation(async () => store.state!.config);
  store.claimOutboundMessages.mockImplementation(async (limit?: number) => claimPendingOutboundMessages(store.state!, { limit }));
  store.markOutboundMessage.mockImplementation(async (messageId: string, status: "sent" | "failed", error?: string, retryCount?: number) => {
    try {
      return status === "sent"
        ? markOutboundMessageSent(store.state!, messageId)
        : markOutboundMessageFailed(store.state!, messageId, error ?? "发送失败", undefined, retryCount);
    } catch {
      return undefined;
    }
  });
  queue.enqueueOutboundMessages.mockImplementation(async (messages: unknown[]) => messages.length);
  process.env.WECHAT_MCP_SECRET = "bridge-secret";
  process.env.CUSTOM_WECHAT_SECRET = "custom-secret";
});

describe("wechat outbound routes", () => {
  it("dispatches claimed outbound messages to BullMQ", async () => {
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ messages: [], queued: 1 });
    expect(queue.enqueueOutboundMessages).toHaveBeenCalledWith([
      expect.objectContaining({ targetName: "张三", text: "请补充展位号", status: "sending" })
    ]);
    expect(store.runAutoAcceptance).toHaveBeenCalledOnce();
    expect(store.claimOutboundMessages).toHaveBeenCalledWith(5);
    expect(store.runAutoAcceptance.mock.invocationCallOrder[0]).toBeLessThan(store.claimOutboundMessages.mock.invocationCallOrder[0]);
  });

  it("returns 503 when Redis cannot accept claimed messages", async () => {
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });
    queue.enqueueOutboundMessages.mockRejectedValueOnce(new Error("redis unavailable"));

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ message: "出站队列暂不可用" });
  });

  it("marks a claimed message as sent", async () => {
    const message = queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "已创建工单" });

    const response = await outboundResultRoute.PATCH(request({ status: "sent" }, { "x-mcp-secret": "bridge-secret" }), {
      params: Promise.resolve({ messageId: message.id })
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.[0].status).toBe("sent");
  });

  it("records exhausted BullMQ attempts on terminal failure", async () => {
    const message = queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "发送失败测试" });

    const response = await outboundResultRoute.PATCH(request({
      status: "failed",
      error: "wxauto unavailable",
      attemptsMade: 3
    }, { "x-mcp-secret": "bridge-secret" }), {
      params: Promise.resolve({ messageId: message.id })
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.[0]).toMatchObject({ status: "failed", retryCount: 3 });
  });

  it("rejects bridge calls with a wrong secret", async () => {
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bad-secret" }));

    expect(response.status).toBe(401);
    expect(store.claimOutboundMessages).not.toHaveBeenCalled();
  });

  it("rejects outbound claims when the configured MCP secret env is missing", async () => {
    delete process.env.WECHAT_MCP_SECRET;
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));

    expect(response.status).toBe(401);
    expect(store.claimOutboundMessages).not.toHaveBeenCalled();
  });

  it("rejects outbound completion when the configured MCP secret env is missing", async () => {
    delete process.env.WECHAT_MCP_SECRET;
    const message = queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "已创建工单" });

    const response = await outboundResultRoute.PATCH(request({ status: "sent" }, { "x-mcp-secret": "bridge-secret" }), {
      params: Promise.resolve({ messageId: message.id })
    });

    expect(response.status).toBe(401);
    expect(store.markOutboundMessage).not.toHaveBeenCalled();
  });

  it("uses the configured WeChat integration secret env", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "CUSTOM_WECHAT_SECRET", autoCreateTickets: false }
    ];
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const rejected = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));
    const accepted = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "custom-secret" }));

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(200);
  });

  it("rejects outbound claims when the WeChat integration is disabled", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: false, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false }
    ];
    queueOutboundMessage(store.state!, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const response = await outboundRoute.POST(request({ limit: 5 }, { "x-mcp-secret": "bridge-secret" }));

    expect(response.status).toBe(400);
    expect(store.claimOutboundMessages).not.toHaveBeenCalled();
  });

  it("returns 404 when marking a missing outbound message", async () => {
    const response = await outboundResultRoute.PATCH(request({ status: "sent" }, { "x-mcp-secret": "bridge-secret" }), {
      params: Promise.resolve({ messageId: "missing-outbound" })
    });

    expect(response.status).toBe(404);
    expect(store.markOutboundMessage).toHaveBeenCalledWith("missing-outbound", "sent", undefined, undefined);
  });
});
