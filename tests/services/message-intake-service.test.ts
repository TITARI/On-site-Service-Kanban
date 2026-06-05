import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { createMessageIntakeService } from "@/lib/services/message-intake-service";
import { defaultConfig } from "@/lib/seed";
import type { AppState } from "@/lib/storage/file-store";

function state(): AppState {
  return {
    booths: [
      { boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }
    ],
    tickets: [],
    messageRecords: [],
    config: {
      ...defaultConfig(),
      messageIntegrations: [
        { id: "wecom", channel: "wecom", label: "企业微信 MCP", enabled: true, mcpServerName: "wecom-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECOM_MCP_SECRET", autoCreateTickets: false }
      ]
    }
  };
}

const existingTicket: Ticket = {
  id: "ticket-1",
  title: "A01 星河科技 网络",
  boothNumber: "A01",
  companyName: "上海星河科技有限公司",
  companyShortName: "星河科技",
  description: "网络断开，扫码收款失败",
  imageUrls: [],
  issueType: "网络",
  submitterId: "member-1",
  submitterName: "张三",
  submitterPhone: "13800138000",
  feedbackUsers: [],
  status: "处理中",
  assignmentGroup: "搭建组",
  urgeCount: 0,
  urgeLevel: 0,
  priorityScore: 25,
  aiDecisions: [],
  replies: [],
  timeline: [],
  createdAt: "2026-05-22T08:00:00.000Z",
  updatedAt: "2026-05-22T08:00:00.000Z"
};

describe("message intake service", () => {
  it("records a WeCom message and understands it can create a ticket", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wecom",
      externalMessageId: "msg-1",
      senderName: "业务王宁",
      senderPhone: "13700137000",
      text: "A01 展位网络断了，客户扫码收款失败",
      imageUrls: ["data:image/jpeg;base64,abc"]
    });

    expect(appState.messageRecords).toHaveLength(1);
    expect(record.analysis).toMatchObject({
      boothNumber: "A01",
      issueType: "网络",
      suggestedAction: "create-ticket"
    });
    expect(record.imageUrls).toEqual(["data:image/jpeg;base64,abc"]);
  });

  it("treats same-booth same-issue messages as urging an existing ticket", async () => {
    const appState = state();
    appState.tickets.push(existingTicket);
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wecom",
      senderName: "搭建李工",
      text: "A01 网络还是不行，麻烦催一下"
    });

    expect(record.analysis.suggestedAction).toBe("urge-existing");
    expect(record.analysis.matchedTicketId).toBe("ticket-1");
  });

  it("keeps unclear operational messages for manual review instead of auto creating tickets", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wechat",
      senderName: "展商赵总",
      text: "现场需要再加一把椅子，位置在主通道附近"
    });

    expect(record.analysis.suggestedAction).toBe("needs-review");
    expect(record.analysis.boothNumber).toBeUndefined();
  });

  it("records digit-prefixed booth numbers and contact failures", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wechat",
      senderName: "刘基鑫",
      text: "1AT201 电联不通"
    });

    expect(record.analysis).toMatchObject({
      boothNumber: "1AT201",
      issueType: "综合服务",
      suggestedAction: "create-ticket"
    });
  });

  it("uses AI classification for booth messages without operational keywords", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wechat",
      senderName: "刘基鑫",
      text: "1BT03 展台没网"
    });

    expect(record.analysis).toMatchObject({
      boothNumber: "1BT03",
      issueType: "网络",
      suggestedAction: "create-ticket"
    });
  });

  it("falls back unclear booth messages to comprehensive service", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const record = await service.recordMessage({
      channel: "wechat",
      senderName: "刘基鑫",
      text: "1BT03 展台有其他家杂物未清理"
    });

    expect(record.analysis).toMatchObject({
      boothNumber: "1BT03",
      issueType: "综合服务",
      suggestedAction: "create-ticket"
    });
  });

  it("deduplicates external messages and preserves raw payload summaries", async () => {
    const appState = state();
    const service = createMessageIntakeService({ state: appState });

    const first = await service.recordMessage({
      channel: "wecom",
      externalMessageId: "msg-duplicate",
      senderName: "业务王宁",
      text: "A01 展位网络断了",
      raw: { source: "wxauto" }
    });
    const second = await service.recordMessage({
      channel: "wecom",
      externalMessageId: "msg-duplicate",
      senderName: "业务王宁",
      text: "A01 展位网络断了",
      raw: { source: "retry" }
    });

    expect(second).toBe(first);
    expect(appState.messageRecords).toHaveLength(1);
    expect(first.raw).toEqual({ source: "wxauto" });
  });
});
