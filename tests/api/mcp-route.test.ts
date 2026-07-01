import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AppState } from "@/lib/domain/app-state";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { processWechatWatchtowerMessage } from "@/lib/services/wechat-watchtower-service";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  runAutoAcceptance: vi.fn(),
  getConfig: vi.fn(),
  processWechatMessage: vi.fn(),
  claimOutboundMessages: vi.fn(),
  markOutboundMessage: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    runAutoAcceptance: store.runAutoAcceptance,
    getConfig: store.getConfig,
    processWechatMessage: store.processWechatMessage,
    claimOutboundMessages: store.claimOutboundMessages,
    markOutboundMessage: store.markOutboundMessage
  } as unknown as AppRepository)
}));

const route = await import("@/app/api/mcp/route");

async function routeFetch(input: string | URL | Request, init?: RequestInit) {
  const request = input instanceof Request
    ? new Request(input, init)
    : new Request(input instanceof URL ? input.toString() : input, init);

  if (request.method === "GET") return route.GET(request);
  if (request.method === "DELETE") return route.DELETE(request);
  if (request.method === "OPTIONS") return route.OPTIONS();
  return route.POST(request);
}

function contentResult<T extends Record<string, unknown>>(result: Awaited<ReturnType<Client["callTool"]>>) {
  if (result.structuredContent) return result.structuredContent as T;
  const item = Array.isArray(result.content) ? result.content[0] : undefined;
  if (item?.type === "text") return JSON.parse(item.text) as T;
  throw new Error("Tool result did not contain structured content or JSON text");
}

async function submitWechatEvent(client: Client, event: Record<string, unknown>) {
  return contentResult<{ receipts: Array<{ messageId: string; action: string; inboundMessageId?: string }> }>(await client.callTool({
    name: "submit_wechat_events",
    arguments: { deviceId: "device-a", events: [event] }
  }));
}

async function connectClient(token = "test-token") {
  const client = new Client({ name: "wxauto-route-test", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL("https://board.example/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: routeFetch
  });
  await client.connect(transport);
  return client;
}

function mcpState(): AppState {
  return {
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
      wxautoMcp: { enabled: true, endpoint: "/api/mcp", accessToken: "test-token", autoCreateTickets: true },
      messageIntegrations: [
        { id: "wechat", channel: "wechat", label: "wxauto 桌面服务", enabled: true, mcpServerName: "wxauto-desktop", endpoint: "/api/mcp", secretEnv: "WXAUTO_MCP_TOKEN", autoCreateTickets: true }
      ]
    }
  };
}

beforeEach(() => {
  process.env.WXAUTO_MCP_TOKEN = "test-token";
  delete process.env.WECHAT_MCP_SECRET;
  store.state = undefined;
  store.runAutoAcceptance.mockReset().mockResolvedValue(undefined);
  store.getConfig.mockReset().mockResolvedValue({
    ...defaultConfig(),
    wxautoMcp: { enabled: true, endpoint: "/api/mcp", accessToken: "test-token", autoCreateTickets: false },
    messageIntegrations: [
      { id: "wechat", channel: "wechat", label: "wxauto 桌面服务", enabled: true, mcpServerName: "wxauto-desktop", endpoint: "/api/mcp", secretEnv: "WXAUTO_MCP_TOKEN", autoCreateTickets: false }
    ]
  });
  store.processWechatMessage.mockReset().mockResolvedValue({
    action: "processed",
    record: { id: "message-1" }
  });
  store.claimOutboundMessages.mockReset().mockResolvedValue([{
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
  store.markOutboundMessage.mockReset().mockResolvedValue({ id: "outbound-1" });
});

describe("POST /api/mcp", () => {
  it("exposes the four wxauto tools to a standard MCP client", async () => {
    const client = await connectClient();
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "claim_outbound_messages",
        "complete_outbound_message",
        "register_wxauto_agent",
        "submit_wechat_events"
      ]);
    } finally {
      await client.close();
    }
  });

  it("registers an agent and submits inbound events through MCP", async () => {
    const client = await connectClient();
    try {
      const register = contentResult(await client.callTool({
        name: "register_wxauto_agent",
        arguments: {
          deviceId: "device-a",
          displayName: "PC",
          appVersion: "0.1.0",
          workerVersion: "0.1.0",
          windowsVersion: "Windows 11",
          wechatProcessState: "running",
          wechatLoginState: "logged_in",
          safetyMode: "strict",
          capabilities: ["text"]
        }
      }));
      expect(register).toMatchObject({ deviceId: "device-a", integrationEnabled: true });

      const submit = contentResult<{ receipts: Array<{ messageId: string; action: string; inboundMessageId?: string }> }>(await client.callTool({
        name: "submit_wechat_events",
        arguments: {
          deviceId: "device-a",
          events: [{
            messageId: "wx-1",
            sequence: 1,
            conversationId: "conv-site",
            conversationType: "group",
            senderName: "张三",
            text: "A01 网络断了",
            receivedAt: "2026-06-05T08:00:00.000Z"
          }]
        }
      }));
      expect(submit.receipts).toEqual([{ messageId: "wx-1", action: "processed", inboundMessageId: "message-1" }]);
    } finally {
      await client.close();
    }
  });

  it("returns JSON receipts for wxauto events without stable sender ids", async () => {
    store.processWechatMessage.mockResolvedValueOnce({
      action: "prompted",
      record: { id: "message-temp-1" }
    });
    const client = await connectClient();
    try {
      const submit = contentResult<{ receipts: Array<{ messageId: string; action: string; inboundMessageId?: string }> }>(await client.callTool({
        name: "submit_wechat_events",
        arguments: {
          deviceId: "device-a",
          events: [{
            messageId: "wx-temp-1",
            sequence: 1,
            conversationId: "conv-site",
            conversationType: "group",
            senderName: "张三",
            text: "注册 搭建组 张三 13800138000",
            receivedAt: "2026-06-05T08:00:00.000Z"
          }]
        }
      }));

      expect(submit.receipts).toEqual([{ messageId: "wx-temp-1", action: "prompted", inboundMessageId: "message-temp-1" }]);
      expect(store.processWechatMessage).toHaveBeenCalledWith(expect.objectContaining({
        senderId: undefined,
        senderName: "张三",
        senderGroup: "conv-site"
      }));
    } finally {
      await client.close();
    }
  });

  it("keeps image work orders intact through MCP event submission", async () => {
    store.state = mcpState();
    store.getConfig.mockImplementation(async () => store.state!.config);
    store.processWechatMessage.mockImplementation(async (input) => processWechatWatchtowerMessage(store.state!, input));

    const client = await connectClient();
    try {
      const image = await submitWechatEvent(client, {
        messageId: "mcp-image-first",
        sequence: 1,
        conversationId: "conv-image",
        conversationType: "group",
        senderId: "wxid-image",
        senderName: "图片用户",
        text: "",
        imageUrls: ["data:image/jpeg;base64,first"],
        receivedAt: "2026-06-05T08:00:00.000Z"
      });
      expect(image.receipts[0]).toMatchObject({ messageId: "mcp-image-first", action: "prompted" });
      expect(store.state.pendingWorkOrderSessions?.[0]).toMatchObject({
        missingFields: ["identityGroup", "name", "phone"],
        draftImages: ["data:image/jpeg;base64,first"]
      });

      const registration = await submitWechatEvent(client, {
        messageId: "mcp-image-register",
        sequence: 1,
        conversationId: "conv-image",
        conversationType: "group",
        senderId: "wxid-image",
        senderName: "图片用户",
        text: "注册 业务组 图片用户 13900139011",
        receivedAt: "2026-06-05T08:00:10.000Z"
      });
      expect(registration.receipts[0]).toMatchObject({ messageId: "mcp-image-register", action: "prompted" });

      const detail = await submitWechatEvent(client, {
        messageId: "mcp-image-detail",
        sequence: 1,
        conversationId: "conv-image",
        conversationType: "group",
        senderId: "wxid-image",
        senderName: "图片用户",
        text: "A01 网络断了，扫码收款失败",
        receivedAt: "2026-06-05T08:00:20.000Z"
      });
      expect(detail.receipts[0]).toMatchObject({ messageId: "mcp-image-detail", action: "processed" });
      expect(store.state.tickets.at(-1)).toMatchObject({
        boothNumber: "A01",
        issueType: "网络",
        imageUrls: ["data:image/jpeg;base64,first"]
      });

      const followup = await submitWechatEvent(client, {
        messageId: "mcp-image-followup",
        sequence: 1,
        conversationId: "conv-image",
        conversationType: "group",
        senderId: "wxid-image",
        senderName: "图片用户",
        text: "",
        imageUrls: ["data:image/jpeg;base64,after"],
        receivedAt: "2026-06-05T08:00:30.000Z"
      });
      expect(followup.receipts[0]).toMatchObject({ messageId: "mcp-image-followup", action: "processed" });
      expect(store.state.tickets.at(-1)?.imageUrls).toEqual([
        "data:image/jpeg;base64,first",
        "data:image/jpeg;base64,after"
      ]);
    } finally {
      await client.close();
    }
  });

  it("updates tickets from handler image receipts submitted through MCP", async () => {
    store.state = mcpState();
    store.getConfig.mockImplementation(async () => store.state!.config);
    store.processWechatMessage.mockImplementation(async (input) => processWechatWatchtowerMessage(store.state!, input));
    const timestamp = "2026-06-05T08:00:00.000Z";
    store.state.people = [{
      id: "person-builder",
      name: "李工",
      phone: "13900139014",
      role: "handler",
      groupName: "搭建组",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
    store.state.chatIdentities = [{
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
    store.state.tickets.push({
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

    const client = await connectClient();
    try {
      const result = await submitWechatEvent(client, {
        messageId: "mcp-builder-done",
        sequence: 1,
        conversationId: "搭建组",
        conversationType: "group",
        senderId: "wxid-builder",
        senderName: "李工微信",
        text: "A01 已处理完成，现场测试正常",
        imageUrls: ["data:image/jpeg;base64,done"],
        receivedAt: "2026-06-05T08:01:00.000Z"
      });

      expect(result.receipts[0]).toMatchObject({ messageId: "mcp-builder-done", action: "processed" });
      expect(store.state.tickets[0].status).toBe("已解决");
      expect(store.state.tickets[0].replies.at(-1)).toMatchObject({
        authorName: "李工",
        role: "handler",
        imageUrls: ["data:image/jpeg;base64,done"]
      });
    } finally {
      await client.close();
    }
  });

  it("claims and completes outbound messages through MCP", async () => {
    const client = await connectClient();
    try {
      const claim = contentResult<{ messages: Array<{ messageId: string; leaseId: string; text: string }> }>(await client.callTool({
        name: "claim_outbound_messages",
        arguments: { deviceId: "device-a", limit: 5 }
      }));
      expect(claim.messages[0]).toMatchObject({ messageId: "outbound-1", leaseId: "outbound-1", text: "已创建工单" });

      const complete = contentResult<{ accepted: boolean }>(await client.callTool({
        name: "complete_outbound_message",
        arguments: {
          deviceId: "device-a",
          messageId: "outbound-1",
          leaseId: "outbound-1",
          status: "sent",
          attemptedAt: "2026-06-05T08:00:30.000Z"
        }
      }));
      expect(complete.accepted).toBe(true);
      expect(store.markOutboundMessage).toHaveBeenCalledWith("outbound-1", "sent", undefined);
    } finally {
      await client.close();
    }
  });

  it("rejects missing bearer authentication", async () => {
    const response = await route.POST(new Request("https://board.example/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "x", version: "1" }
        }
      })
    }));

    expect(response.status).toBe(401);
  });
});
