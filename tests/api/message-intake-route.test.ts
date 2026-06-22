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

function enableWechat() {
  store.state!.config.messageIntegrations = [
    { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
  ];
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
    enableWechat();

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
    enableWechat();

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
    enableWechat();

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

  it("keeps image-only first messages through registration and ticket creation", async () => {
    enableWechat();

    const imageResponse = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-image-first",
      senderId: "wxid-image-first",
      senderName: "图片用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-image-first",
      images: [{ url: "data:image/jpeg;base64,first" }]
    }));

    expect(imageResponse.status).toBe(200);
    expect((await imageResponse.json()).action).toBe("prompted");
    expect(store.state?.pendingWorkOrderSessions?.[0]).toMatchObject({
      missingFields: ["identityGroup", "name", "phone"],
      draftImages: ["data:image/jpeg;base64,first"]
    });

    const registerResponse = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-image-register",
      senderId: "wxid-image-first",
      senderName: "图片用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-image-first",
      text: "注册 业务组 图片用户 13900139011"
    }));

    expect(registerResponse.status).toBe(200);
    expect((await registerResponse.json()).action).toBe("prompted");
    expect(store.state?.pendingWorkOrderSessions?.[0]).toMatchObject({
      missingFields: ["boothNumber"],
      draftImages: ["data:image/jpeg;base64,first"]
    });

    const textResponse = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-image-text",
      senderId: "wxid-image-first",
      senderName: "图片用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-image-first",
      text: "A01 网络断了，扫码收款失败"
    }));

    expect(textResponse.status).toBe(200);
    expect((await textResponse.json()).action).toBe("processed");
    expect(store.state?.pendingWorkOrderSessions).toEqual([]);
    expect(store.state?.tickets.at(-1)).toMatchObject({
      boothNumber: "A01",
      issueType: "网络",
      submitterName: "图片用户",
      imageUrls: ["data:image/jpeg;base64,first"]
    });
  });

  it("attaches image-only follow-ups to the latest ticket from the same REST conversation", async () => {
    enableWechat();

    await POST(request({
      channel: "wechat",
      externalMessageId: "wx-follow-register",
      senderId: "wxid-follow",
      senderName: "补图用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-follow",
      text: "注册 业务组 补图用户 13900139012"
    }));
    await POST(request({
      channel: "wechat",
      externalMessageId: "wx-follow-create",
      senderId: "wxid-follow",
      senderName: "补图用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-follow",
      text: "A01 网络断了，扫码收款失败"
    }));

    const ticket = store.state!.tickets.at(-1)!;
    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-follow-image",
      senderId: "wxid-follow",
      senderName: "补图用户",
      senderGroup: "现场群",
      sourceConversationId: "conv-follow",
      image_urls: ["data:image/jpeg;base64,after"]
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("processed");
    expect(ticket.imageUrls).toEqual(["data:image/jpeg;base64,after"]);
    expect(store.state?.messageRecords.at(-1)?.analysis).toMatchObject({
      matchedTicketId: ticket.id,
      reason: expect.stringContaining("补充图片")
    });
  });

  it("updates an assigned ticket when the handler sends a completion receipt with images", async () => {
    enableWechat();
    const timestamp = "2026-05-22T08:00:00.000Z";
    store.state!.people = [{
      id: "person-builder",
      name: "李工",
      phone: "13900139014",
      role: "handler",
      groupName: "搭建组",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
    store.state!.chatIdentities = [{
      id: "identity-builder",
      platform: "wechat",
      externalUserId: "wxid-builder",
      displayName: "李工微信",
      personId: "person-builder",
      verifiedBy: "phone",
      verifiedAt: timestamp,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    }];
    store.state!.tickets.push({
      id: "ticket-builder",
      title: "A01 星河科技 搭建",
      boothNumber: "A01",
      companyName: "上海星河科技有限公司",
      companyShortName: "星河科技",
      description: "A01 门头松动",
      imageUrls: [],
      issueType: "搭建",
      submitterId: "person-reporter",
      submitterName: "王宁",
      submitterPhone: "13700137000",
      reporterChatIdentityId: "identity-reporter",
      sourceConversationId: "客户群",
      feedbackUsers: [],
      status: "处理中",
      acceptedAt: timestamp,
      assignmentGroup: "搭建组",
      urgeCount: 0,
      urgeLevel: 0,
      priorityScore: 20,
      aiDecisions: [],
      replies: [],
      timeline: [{ id: "timeline-builder", ticketId: "ticket-builder", type: "submitted", body: "A01 门头松动", createdAt: timestamp, actorName: "王宁" }],
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const response = await POST(request({
      channel: "wechat",
      externalMessageId: "wx-builder-done",
      senderId: "wxid-builder",
      senderName: "李工微信",
      senderGroup: "搭建组",
      sourceConversationId: "搭建组",
      text: "A01 已处理完成，现场测试正常",
      imageUrls: ["data:image/jpeg;base64,done"]
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).action).toBe("processed");
    const ticket = store.state!.tickets[0];
    expect(ticket.status).toBe("已解决");
    expect(ticket.replies.at(-1)).toMatchObject({
      authorName: "李工",
      role: "handler",
      imageUrls: ["data:image/jpeg;base64,done"]
    });
    expect(store.state?.outboundMessages?.some((message) => (
      message.targetName === "客户群" && message.text.includes("工单已解决：A01 星河科技 搭建")
    ))).toBe(true);
  });
});
