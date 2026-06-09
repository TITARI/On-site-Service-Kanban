import { afterEach, describe, expect, it } from "vitest";
import type { AppState } from "@/lib/storage/file-store";
import { ticketShortCode } from "@/lib/domain/ticket-links";
import { defaultConfig } from "@/lib/seed";
import { processWechatWatchtowerMessage } from "@/lib/services/wechat-watchtower-service";

const originalPublicBaseUrl = process.env.APP_PUBLIC_BASE_URL;

afterEach(() => {
  if (originalPublicBaseUrl === undefined) {
    delete process.env.APP_PUBLIC_BASE_URL;
  } else {
    process.env.APP_PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

function state(): AppState {
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
      messageIntegrations: [
        { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: true, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: true }
      ],
      userGroups: [
        { id: "builder", name: "搭建组", description: "搭建", canClaim: true, canProcess: true, canAccept: false, enabled: true },
        { id: "organizer", name: "主场组", description: "主场", canClaim: false, canProcess: false, canAccept: true, enabled: true },
        { id: "business", name: "业务组", description: "业务", canClaim: false, canProcess: false, canAccept: true, enabled: true }
      ]
    }
  };
}

describe("wechat watchtower service", () => {
  it("silently records ordinary chat from an unknown user", async () => {
    const appState = state();

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-chat-1",
      senderId: "wxid-1",
      senderName: "路人甲",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "大家辛苦了"
    });

    expect(result.action).toBe("ignored");
    expect(appState.messageRecords).toHaveLength(1);
    expect(appState.outboundMessages).toEqual([]);
  });

  it("prompts an unknown user to register before processing an operational request", async () => {
    const appState = state();

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01 网络断了，扫码收款失败"
    });

    expect(result.action).toBe("prompted");
    expect(appState.tickets).toEqual([]);
    expect(appState.pendingWorkOrderSessions).toHaveLength(1);
    expect(appState.pendingWorkOrderSessions?.[0].missingFields).toEqual(["identityGroup", "name", "phone"]);
    expect(appState.outboundMessages?.[0].text).toContain("请补充身份组、真实姓名、手机号");
  });

  it("prompts an unknown direct WeChat sender for registration on contact failure", async () => {
    const appState = state();

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-direct-contact-failed",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "1AT201 电联不通"
    });

    expect(result.action).toBe("prompted");
    expect(appState.tickets).toEqual([]);
    expect(appState.pendingWorkOrderSessions).toHaveLength(1);
    expect(appState.pendingWorkOrderSessions?.[0].missingFields).toEqual(["identityGroup", "name", "phone"]);
    expect(appState.messageRecords[0].analysis).toMatchObject({ boothNumber: "1AT201", issueType: "综合服务" });
    expect(appState.outboundMessages?.[0]).toMatchObject({ targetName: "刘基鑫" });
  });

  it("collects identity answers across follow-up messages before creating the ticket", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-direct-contact-failed",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "1AT201 电联不通"
    });

    const nameResult = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-direct-name-phone",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "刘基鑫，18638638860"
    });

    expect(nameResult.action).toBe("prompted");
    expect(appState.pendingWorkOrderSessions?.[0]).toMatchObject({
      contactName: "刘基鑫",
      contactPhone: "18638638860",
      missingFields: ["identityGroup"],
      draftText: "1AT201 电联不通"
    });

    const groupResult = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-direct-group",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "主场组"
    });

    expect(groupResult.action).toBe("processed");
    expect(appState.pendingWorkOrderSessions).toEqual([]);
    expect(appState.people?.[0]).toMatchObject({ name: "刘基鑫", phone: "18638638860", groupName: "主场组" });
    expect(appState.tickets[0]).toMatchObject({ boothNumber: "1AT201", issueType: "综合服务", submitterName: "刘基鑫" });
  });

  it("registers from command and continues the pending request", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01 网络断了，扫码收款失败"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-1",
      senderId: "wxid-2",
      senderName: "张三微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 张三 13800138000"
    });

    expect(result.action).toBe("processed");
    expect(appState.people).toHaveLength(1);
    expect(appState.pendingWorkOrderSessions).toEqual([]);
    expect(appState.tickets).toHaveLength(1);
    expect(appState.tickets[0]).toMatchObject({ boothNumber: "A01", issueType: "网络", submitterName: "张三" });
    expect(appState.outboundMessages?.some((message) => message.text.includes("现场工单已创建成功"))).toBe(true);
  });

  it("prompts instead of throwing when a wxauto group sender has no stable sender id", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-temp-identity-request",
      senderName: "张三微信",
      senderGroup: "conv-site",
      sourceConversationId: "conv-site",
      text: "A01 网络断了，扫码收款失败"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-temp-identity-register",
      senderName: "张三微信",
      senderGroup: "conv-site",
      sourceConversationId: "conv-site",
      text: "注册 搭建组 张三 13800138000"
    });

    expect(result.action).toBe("prompted");
    expect(appState.people).toEqual([]);
    expect(appState.tickets).toEqual([]);
    expect(appState.pendingWorkOrderSessions).toHaveLength(1);
    expect(appState.outboundMessages?.at(-1)?.text).toContain("缺少稳定微信用户标识，无法绑定");
  });

  it("queues a short ticket detail link in the creation receipt", async () => {
    process.env.APP_PUBLIC_BASE_URL = "https://board.example.com";
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-shortlink-identity",
      senderId: "wxid-shortlink",
      senderName: "短链微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-shortlink",
      text: "1BT03 展台有其他家杂物未清理"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-shortlink-register",
      senderId: "wxid-shortlink",
      senderName: "短链微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-shortlink",
      text: "注册 业务组 刘基鑫 18638638860"
    });

    expect(result.action).toBe("processed");
    const ticket = appState.tickets[0];
    const receipt = appState.outboundMessages?.find((message) => message.relatedTicketId === ticket.id && message.text.includes("现场工单已创建成功"));

    expect(receipt).toBeDefined();
    expect(receipt!.text).toContain("现场工单已创建成功！");
    expect(receipt!.text).toContain(`名称：${ticket.title}`);
    expect(receipt!.text).toContain("展位：1BT03");
    expect(receipt!.text).toContain("类型：综合服务");
    expect(receipt!.text).toContain("当前进度：待受理");
    expect(receipt!.text).toContain(`工单详情：https://board.example.com/t/${ticketShortCode(ticket.id)}`);
  });

  it("continues prompting for booth number after an unknown user registers", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity-no-booth",
      senderId: "wxid-need-booth",
      senderName: "缺展位微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "这里没电了，麻烦处理"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-need-booth",
      senderId: "wxid-need-booth",
      senderName: "缺展位微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 钱七 13900139002"
    });

    expect(result.action).toBe("prompted");
    expect(appState.people).toHaveLength(1);
    expect(appState.tickets).toEqual([]);
    expect(appState.pendingWorkOrderSessions).toHaveLength(1);
    expect(appState.pendingWorkOrderSessions?.[0]).toMatchObject({
      personId: appState.people?.[0].id,
      missingFields: ["boothNumber"],
      draftText: "这里没电了，麻烦处理"
    });
    expect(appState.outboundMessages?.at(-1)?.text).toContain("请补充展位号");
  });

  it("creates a comprehensive-service ticket after an unknown user registers when issue type is unclear", async () => {
    const appState = state();
    appState.config.aiModels = appState.config.aiModels.map((model) => model.id === "fast" ? { ...model, enabled: false } : model);
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-need-identity-no-issue",
      senderId: "wxid-need-issue",
      senderName: "缺类型微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01 这里需要处理"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-need-issue",
      senderId: "wxid-need-issue",
      senderName: "缺类型微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 孙八 13900139003"
    });

    expect(result.action).toBe("processed");
    expect(appState.pendingWorkOrderSessions).toEqual([]);
    expect(appState.tickets).toHaveLength(1);
    expect(appState.tickets[0]).toMatchObject({
      boothNumber: "A01",
      issueType: "综合服务",
      submitterName: "孙八"
    });
  });

  it("prompts a registered user for missing booth number", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-2",
      senderId: "wxid-3",
      senderName: "李四微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 李四 13900139000"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-missing-booth",
      senderId: "wxid-3",
      senderName: "李四微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "这里没电了，麻烦处理"
    });

    expect(result.action).toBe("prompted");
    expect(appState.pendingWorkOrderSessions?.at(-1)?.missingFields).toContain("boothNumber");
    expect(appState.outboundMessages?.at(-1)?.text).toContain("请补充展位号");
  });

  it("processes registered booth messages without operational keywords as comprehensive service", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-comprehensive",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "注册 业务组 刘基鑫 18638638860"
    });
    appState.outboundMessages = [];

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-comprehensive-booth",
      senderId: "wechat-direct:刘基鑫",
      senderName: "刘基鑫",
      sourceConversationId: "刘基鑫",
      text: "1BT03 展台有其他家杂物未清理"
    });

    expect(result.action).toBe("processed");
    expect(appState.tickets.at(-1)).toMatchObject({
      boothNumber: "1BT03",
      issueType: "综合服务",
      submitterName: "刘基鑫"
    });
    expect(appState.outboundMessages?.map((message) => message.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("现场工单已创建成功"),
      expect.stringContaining("新工单")
    ]));
  });

  it("lets smart AI expedite a matched ticket and notify admins on high-pressure follow-up", async () => {
    const appState = state();
    const timestamp = "2026-05-22T08:00:00.000Z";
    appState.people = [{
      id: "person-urgent",
      name: "王宁",
      phone: "13700137000",
      role: "reporter",
      groupName: "业务组",
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
    appState.chatIdentities = [{
      id: "identity-urgent",
      platform: "wechat",
      externalUserId: "wxid-urgent",
      displayName: "王宁微信",
      personId: "person-urgent",
      verifiedBy: "phone",
      verifiedAt: timestamp,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp
    }];
    appState.conversations = [{
      id: "conversation-urgent",
      platform: "wechat",
      type: "group",
      externalConversationId: "现场保障群",
      title: "现场保障群",
      linkedPersonIds: ["person-urgent"],
      defaultNotify: true,
      createdAt: timestamp,
      updatedAt: timestamp
    }];
    appState.tickets.push({
      id: "ticket-urgent",
      title: "A01 星河科技 网络",
      boothNumber: "A01",
      companyName: "上海星河科技有限公司",
      companyShortName: "星河科技",
      description: "A01 网络断了，客户扫码失败",
      imageUrls: [],
      issueType: "网络",
      submitterId: "person-urgent",
      submitterName: "王宁",
      submitterPhone: "13700137000",
      reporterPersonId: "person-urgent",
      reporterChatIdentityId: "identity-urgent",
      sourceConversationId: "现场保障群",
      feedbackUsers: [],
      status: "待受理",
      assignmentGroup: "网络组",
      urgeCount: 0,
      urgeLevel: 0,
      priorityScore: 25,
      aiDecisions: [],
      replies: [],
      timeline: [{ id: "timeline-submitted", ticketId: "ticket-urgent", type: "submitted", body: "A01 网络断了，客户扫码失败", createdAt: timestamp, actorName: "王宁" }],
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-ai-expedite",
      senderId: "wxid-urgent",
      senderName: "王宁微信",
      senderGroup: "现场保障群",
      sourceConversationId: "现场保障群",
      text: "怎么样了，客户一直在催"
    });

    const ticket = appState.tickets[0];
    expect(result.action).toBe("processed");
    expect(ticket.urgeCount).toBe(1);
    expect(ticket.urgeLevel).toBe(1);
    expect(ticket.priorityScore).toBeGreaterThan(25);
    expect(ticket.aiDecisions.at(-1)).toMatchObject({ scenario: "customer-service", action: "expedite", matchedTicketId: "ticket-urgent" });
    expect(ticket.timeline.at(-1)).toMatchObject({ type: "ai-suggestion", actorName: "系统AI" });
    expect(ticket.timeline.at(-1)?.body).toContain("AI判断客户催办强度较高");
    expect(appState.messageRecords.at(-1)?.analysis).toMatchObject({ suggestedAction: "urge-existing", matchedTicketId: "ticket-urgent" });
    expect(appState.outboundMessages?.some((message) => message.targetName === "管理员" && message.text.includes("AI加急判断"))).toBe(true);
    expect(appState.outboundMessages?.some((message) => message.targetName === "现场保障群" && message.text.includes("已帮您加急"))).toBe(true);
    expect(appState.outboundMessages?.some((message) => message.targetName === "网络组" && message.text.includes("AI加急"))).toBe(true);
  });

  it("uses a follow-up reply to complete the original request", async () => {
    const appState = state();
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-register-3",
      senderId: "wxid-4",
      senderName: "王五微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "注册 搭建组 王五 13900139001"
    });
    await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-missing-booth-2",
      senderId: "wxid-4",
      senderName: "王五微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "这里没电了，麻烦处理"
    });

    const result = await processWechatWatchtowerMessage(appState, {
      channel: "wechat",
      externalMessageId: "msg-booth-reply",
      senderId: "wxid-4",
      senderName: "王五微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "A01"
    });

    expect(result.action).toBe("processed");
    expect(appState.pendingWorkOrderSessions).toEqual([]);
    expect(appState.tickets.at(-1)).toMatchObject({ boothNumber: "A01", issueType: "电力", submitterName: "王五" });
  });

  it("does not process duplicate external messages twice", async () => {
    const appState = state();
    const input = {
      channel: "wechat" as const,
      externalMessageId: "msg-duplicate",
      senderId: "wxid-5",
      senderName: "赵六微信",
      senderGroup: "现场群",
      sourceConversationId: "conv-1",
      text: "大家辛苦了"
    };

    await processWechatWatchtowerMessage(appState, input);
    const result = await processWechatWatchtowerMessage(appState, input);

    expect(result.action).toBe("duplicate");
    expect(appState.messageRecords).toHaveLength(1);
    expect(appState.outboundMessages).toEqual([]);
  });
});
