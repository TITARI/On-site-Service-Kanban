import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { processWechatWatchtowerMessage } from "@/lib/services/wechat-watchtower-service";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  getConfig: vi.fn(),
  processWechatMessage: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    getConfig: store.getConfig,
    processWechatMessage: store.processWechatMessage
  } as unknown as AppRepository)
}));

const { POST } = await import("@/app/api/integrations/wechat/messages/route");

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/integrations/wechat/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  delete process.env.WECOM_MCP_SECRET;
  delete process.env.WECHAT_MCP_SECRET;
  store.state = {
    booths: [
      { boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }
    ],
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
        { id: "wecom", channel: "wecom", label: "企业微信 MCP", enabled: true, mcpServerName: "wecom-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECOM_MCP_SECRET", autoCreateTickets: false },
        { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: false, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false }
      ]
    }
  };
  store.getConfig.mockReset();
  store.processWechatMessage.mockReset();
  store.getConfig.mockImplementation(async () => store.state!.config);
  store.processWechatMessage.mockImplementation(async (input) => processWechatWatchtowerMessage(store.state!, input));
});

describe("message intake route", () => {
  it("accepts enabled WeCom MCP messages and persists understood records", async () => {
    const response = await POST(request({
      channel: "wecom",
      externalMessageId: "wx-msg-1",
      senderName: "业务王宁",
      senderPhone: "13700137000",
      text: "A01 展位网络断了，客户扫码收款失败"
    }));

    expect(response.status).toBe(200);
    const { record } = await response.json();
    expect(record.analysis.suggestedAction).toBe("create-ticket");
    expect(store.state?.messageRecords).toHaveLength(1);
    expect(store.processWechatMessage).toHaveBeenCalledOnce();
  });

  it("normalizes common MCP payload aliases before recording the message", async () => {
    const response = await POST(request({
      channel: "wecom",
      msgId: "mcp-msg-2",
      fromName: "企微机器人",
      mobile: "13600136000",
      content: "A01 网络又断了，请尽快处理",
      images: ["data:image/png;base64,abc"]
    }));

    expect(response.status).toBe(200);
    const { record } = await response.json();
    expect(record.externalMessageId).toBe("mcp-msg-2");
    expect(record.senderName).toBe("企微机器人");
    expect(record.senderPhone).toBe("13600136000");
    expect(record.text).toBe("A01 网络又断了，请尽快处理");
    expect(record.imageUrls).toEqual(["data:image/png;base64,abc"]);
  });

  it("rejects messages when the configured MCP secret is wrong", async () => {
    process.env.WECOM_MCP_SECRET = "secret-value";

    const response = await POST(request({
      channel: "wecom",
      senderName: "业务王宁",
      text: "A01 网络断了"
    }, { "x-mcp-secret": "bad-secret" }));

    expect(response.status).toBe(401);
    expect(store.processWechatMessage).not.toHaveBeenCalled();
  });

  it("prompts unknown WeChat users to register before creating a ticket", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
    ];

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-1",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "A01 网络断了，扫码收款失败"
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("prompted");
    expect(store.state?.tickets).toEqual([]);
    expect(store.state?.pendingWorkOrderSessions).toHaveLength(1);
    expect(store.state?.outboundMessages?.at(-1)?.text).toContain("请补充身份组、真实姓名、手机号");
  });

  it("registers a WeChat user and continues the pending request", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
    ];

    await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-2",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "A01 网络断了，扫码收款失败"
    }));

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-register-2",
      senderId: "wxid-new",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "注册 搭建组 张三 13800138000"
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("processed");
    expect(store.state?.people).toHaveLength(1);
    expect(store.state?.pendingWorkOrderSessions).toEqual([]);
    expect(store.state?.tickets).toHaveLength(1);
    expect(store.state?.tickets[0]).toMatchObject({ boothNumber: "A01", issueType: "网络", submitterName: "张三", sourceConversationId: "conv-site" });
    expect(store.state?.outboundMessages?.some((message) => message.text.includes("现场工单已创建成功"))).toBe(true);
  });

  it("keeps prompting for missing work-order fields after registration", async () => {
    store.state!.config.messageIntegrations = [
      { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
    ];

    await POST(request({
      channel: "wechat",
      externalMessageId: "wx-watch-missing-booth",
      senderId: "wxid-missing-booth",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "这里没电了，麻烦处理"
    }));

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-register-missing-booth",
      senderId: "wxid-missing-booth",
      senderName: "新用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-site",
      text: "注册 搭建组 张三 13800138000"
    }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.action).toBe("prompted");
    expect(store.state?.tickets).toEqual([]);
    expect(store.state?.pendingWorkOrderSessions).toHaveLength(1);
    expect(store.state?.pendingWorkOrderSessions?.[0]).toMatchObject({ missingFields: ["boothNumber"] });
    expect(store.state?.outboundMessages?.at(-1)?.text).toContain("请补充展位号");
  });
});
