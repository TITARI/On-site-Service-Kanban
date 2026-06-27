import { describe, expect, it } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { Ticket } from "@/lib/domain/types";
import { defaultConfig } from "@/lib/seed";
import { runAutoAcceptanceForState } from "@/lib/services/auto-acceptance-service";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-1",
    title: "A01 星河科技 网络",
    boothNumber: "A01",
    companyName: "上海星河科技有限公司",
    companyShortName: "星河科技",
    description: "网络断了，扫码失败",
    imageUrls: [],
    issueType: "网络",
    submitterId: "member-13800138000",
    submitterName: "张三",
    submitterPhone: "13800138000",
    reporterChatIdentityId: "chat-reporter",
    sourceConversationId: "conv-site",
    feedbackUsers: [{ userId: "member-13800138000", userName: "张三", phone: "13800138000", feedbackAt: "2026-06-05T08:00:00.000Z" }],
    status: "已解决",
    handlerId: "handler-1",
    handlerName: "网络值班",
    assignmentGroup: "网络组",
    urgeCount: 0,
    urgeLevel: 0,
    priorityScore: 25,
    aiDecisions: [],
    replies: [],
    timeline: [
      {
        id: "timeline-resolved",
        ticketId: "ticket-1",
        type: "status-changed",
        body: "状态变更为已解决：已恢复网络",
        createdAt: "2026-06-05T08:00:00.000Z",
        actorName: "网络值班",
        toStatus: "已解决"
      }
    ],
    createdAt: "2026-06-05T07:30:00.000Z",
    updatedAt: "2026-06-05T08:00:00.000Z",
    ...overrides
  };
}

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    booths: [],
    tickets: [ticket()],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: {
      ...defaultConfig(),
      autoAcceptance: { enabled: true, timeoutMinutes: 30 }
    },
    ...overrides
  };
}

describe("auto acceptance service", () => {
  it("does not close resolved tickets before the configured timeout", () => {
    const appState = state();

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:29:59.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
    expect(appState.tickets[0].status).toBe("已解决");
    expect(appState.outboundMessages).toEqual([]);
  });

  it("closes timed-out resolved tickets, records a receipt, and queues both notifications", () => {
    const appState = state();

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:30:00.000Z" });

    expect(result.acceptedTicketIds).toEqual(["ticket-1"]);
    expect(appState.tickets[0].status).toBe("已关闭");
    expect(appState.tickets[0].updatedAt).toBe("2026-06-05T08:30:00.000Z");
    expect(appState.tickets[0].timeline.at(-1)).toMatchObject({
      type: "receipt",
      body: "业务组在 30 分钟内未验收，系统已自动验收通过并关闭工单",
      actorName: "系统"
    });
    expect(appState.outboundMessages).toHaveLength(2);
    expect(appState.outboundMessages?.[0]).toMatchObject({
      targetConversationId: "conv-site",
      targetChatIdentityId: "chat-reporter",
      relatedTicketId: "ticket-1"
    });
    expect(appState.outboundMessages?.[0].text).toContain("系统已自动验收并关闭");
    expect(appState.outboundMessages?.[1]).toMatchObject({
      targetName: "网络组",
      relatedTicketId: "ticket-1"
    });
    expect(appState.outboundMessages?.[1].text).toContain("已自动验收闭环");
  });

  it("uses the last resolved timeline entry instead of stale updatedAt", () => {
    const appState = state({
      tickets: [
        ticket({
          updatedAt: "2026-06-05T07:00:00.000Z",
          timeline: [
            {
              id: "timeline-old-resolved",
              ticketId: "ticket-1",
              type: "status-changed",
              body: "状态变更为已解决：第一次处理完成",
              createdAt: "2026-06-05T07:00:00.000Z",
              actorName: "网络值班",
              toStatus: "已解决"
            },
            {
              id: "timeline-rework",
              ticketId: "ticket-1",
              type: "receipt",
              body: "业务组验收未通过：仍不稳定",
              createdAt: "2026-06-05T07:20:00.000Z",
              actorName: "业务李经理"
            },
            {
              id: "timeline-new-resolved",
              ticketId: "ticket-1",
              type: "status-changed",
              body: "状态变更为已解决：第二次处理完成",
              createdAt: "2026-06-05T08:10:00.000Z",
              actorName: "网络值班",
              toStatus: "已解决"
            }
          ]
        })
      ]
    });

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:39:59.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
    expect(appState.tickets[0].status).toBe("已解决");
  });

  it("uses toStatus when the resolved timeline body changes", () => {
    const appState = state({
      tickets: [
        ticket({
          updatedAt: "2026-06-05T07:00:00.000Z",
          timeline: [{
            id: "timeline-resolved-with-new-copy",
            ticketId: "ticket-1",
            type: "status-changed",
            body: "处理工作已完成",
            createdAt: "2026-06-05T08:10:00.000Z",
            actorName: "网络值班",
            toStatus: "已解决"
          }]
        })
      ]
    });

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:39:59.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
    expect(appState.tickets[0].status).toBe("已解决");
  });

  it("ignores resolved wording when toStatus is not resolved", () => {
    const appState = state({
      tickets: [
        ticket({
          updatedAt: "2026-06-05T08:20:00.000Z",
          timeline: [{
            id: "timeline-processing-with-resolved-copy",
            ticketId: "ticket-1",
            type: "status-changed",
            body: "状态变更为已解决：文案与字段冲突",
            createdAt: "2026-06-05T07:00:00.000Z",
            actorName: "网络值班",
            toStatus: "处理中"
          }]
        })
      ]
    });

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:49:59.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
  });

  it("falls back to updatedAt for legacy timeline entries without toStatus", () => {
    const appState = state({
      tickets: [
        ticket({
          updatedAt: "2026-06-05T08:20:00.000Z",
          timeline: [{
            id: "timeline-legacy-resolved",
            ticketId: "ticket-1",
            type: "status-changed",
            body: "状态变更为已解决：旧数据",
            createdAt: "2026-06-05T07:00:00.000Z",
            actorName: "网络值班"
          }]
        })
      ]
    });

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:49:59.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
  });

  it("is idempotent after the ticket has already been auto accepted", () => {
    const appState = state();

    runAutoAcceptanceForState(appState, { now: "2026-06-05T08:30:00.000Z" });
    const second = runAutoAcceptanceForState(appState, { now: "2026-06-05T08:31:00.000Z" });

    expect(second.acceptedTicketIds).toEqual([]);
    expect(appState.tickets[0].timeline.filter((item) => item.body.includes("自动验收通过"))).toHaveLength(1);
    expect(appState.outboundMessages).toHaveLength(2);
  });

  it("skips all tickets when auto acceptance is disabled", () => {
    const appState = state({
      config: {
        ...defaultConfig(),
        autoAcceptance: { enabled: false, timeoutMinutes: 1 }
      }
    });

    const result = runAutoAcceptanceForState(appState, { now: "2026-06-05T09:00:00.000Z" });

    expect(result.acceptedTicketIds).toEqual([]);
    expect(appState.tickets[0].status).toBe("已解决");
    expect(appState.outboundMessages).toEqual([]);
  });
});
