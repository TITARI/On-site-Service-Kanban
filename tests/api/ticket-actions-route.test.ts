import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "@/lib/domain/app-state";
import type { Ticket } from "@/lib/domain/types";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";
import { queueTicketFeedbackMessage } from "@/lib/services/outbound-message-service";

const store = vi.hoisted(() => ({
  state: undefined as AppState | undefined,
  getTicket: vi.fn(),
  saveTicket: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    getTicket: store.getTicket,
    saveTicket: store.saveTicket
  } as unknown as AppRepository)
}));

const { PATCH } = await import("@/app/api/tickets/[ticketId]/route");

const ticket: Ticket = {
  id: "ticket-1",
  title: "A01 星河科技 搭建",
  boothNumber: "A01",
  companyName: "上海星河科技有限公司",
  companyShortName: "星河科技",
  description: "门头结构松动，需要处理",
  imageUrls: [],
  issueType: "搭建",
  submitterId: "member-13800138000",
  submitterName: "张三",
  submitterPhone: "13800138000",
  feedbackUsers: [{ userId: "member-13800138000", userName: "张三", phone: "13800138000", feedbackAt: "2026-05-21T08:00:00.000Z" }],
  status: "待受理",
  assignmentGroup: "搭建组",
  urgeCount: 0,
  urgeLevel: 0,
  priorityScore: 20,
  aiDecisions: [],
  replies: [],
  timeline: [],
  createdAt: "2026-05-21T08:00:00.000Z",
  updatedAt: "2026-05-21T08:00:00.000Z"
};

function request(body: unknown) {
  return new Request("http://localhost/api/tickets/ticket-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function patch(body: unknown) {
  return PATCH(request(body), { params: Promise.resolve({ ticketId: "ticket-1" }) });
}

beforeEach(() => {
  store.state = {
    booths: [],
    tickets: [{ ...ticket, timeline: [] }],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config: defaultConfig()
  };
  store.getTicket.mockReset();
  store.saveTicket.mockReset();
  store.getTicket.mockImplementation(async (ticketId) => store.state!.tickets.find((item) => item.id === ticketId));
  store.saveTicket.mockImplementation(async (nextTicket: Ticket, options?: { notificationText?: string }) => {
    const index = store.state!.tickets.findIndex((item) => item.id === nextTicket.id);
    if (index >= 0) store.state!.tickets[index] = nextTicket;
    else store.state!.tickets.push(nextTicket);
    if (options?.notificationText) {
      queueTicketFeedbackMessage(store.state!, nextTicket, options.notificationText);
    }
    return nextTicket;
  });
});

describe("ticket action route", () => {
  it("claims a pending ticket for a builder user", async () => {
    const response = await patch({
      action: "claim",
      status: "处理中",
      actorId: "member-13700137000",
      actorName: "搭建王工",
      actorPhone: "13700137000",
      actorGroupName: "搭建组",
      handlerId: "member-13700137000",
      handlerName: "搭建王工",
      handlerPhone: "13700137000"
    });

    expect(response.status).toBe(200);
    const { ticket: updated } = await response.json();
    expect(updated.status).toBe("处理中");
    expect(updated.handlerId).toBe("member-13700137000");
    expect(updated.handlerPhone).toBe("13700137000");
    expect(updated.timeline.at(-1).body).toContain("认领工单");
  });

  it("rejects progress updates without processing content and photos", async () => {
    store.state!.tickets[0] = { ...ticket, status: "处理中", handlerId: "member-13700137000", handlerName: "搭建王工" };

    const response = await patch({
      action: "progress",
      status: "已解决",
      actorId: "member-13700137000",
      actorName: "搭建王工",
      actorGroupName: "搭建组",
      processBody: "已加固门头",
      imageUrls: []
    });

    expect(response.status).toBe(400);
  });

  it("records progress content and images when resolving a ticket", async () => {
    store.state!.tickets[0] = { ...ticket, status: "处理中", handlerId: "member-13700137000", handlerName: "搭建王工" };

    const response = await patch({
      action: "progress",
      status: "已解决",
      actorId: "member-13700137000",
      actorName: "搭建王工",
      actorGroupName: "搭建组",
      processBody: "已加固门头并复核稳定性",
      imageUrls: ["data:image/jpeg;base64,abc"]
    });

    expect(response.status).toBe(200);
    const { ticket: updated } = await response.json();
    expect(updated.status).toBe("已解决");
    expect(updated.replies.at(-1)).toMatchObject({ body: "已加固门头并复核稳定性", imageUrls: ["data:image/jpeg;base64,abc"] });
  });

  it("accepts a resolved ticket and closes it", async () => {
    store.state!.tickets[0] = { ...ticket, status: "已解决" };

    const response = await patch({
      action: "accept",
      status: "已关闭",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组"
    });

    expect(response.status).toBe(200);
    const { ticket: updated } = await response.json();
    expect(updated.status).toBe("已关闭");
    expect(updated.timeline.at(-1).type).toBe("receipt");
  });

  it("rejects a resolved ticket back to rework with an acceptance reason", async () => {
    store.state!.tickets[0] = { ...ticket, status: "已解决", handlerId: "member-13700137000", handlerName: "搭建王工", assignmentGroup: "搭建组" };

    const response = await patch({
      action: "reject",
      status: "待再次处理",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组",
      reason: "门头边角仍有松动，需要重新加固"
    });

    expect(response.status).toBe(200);
    const { ticket: updated } = await response.json();
    expect(updated.status).toBe("待再次处理");
    expect(updated.assignmentGroup).toBe("搭建组");
    expect(updated.timeline.at(-1)).toMatchObject({
      type: "receipt",
      body: "业务组验收未通过：门头边角仍有松动，需要重新加固"
    });
  });

  it("requires a reason when rejecting acceptance", async () => {
    store.state!.tickets[0] = { ...ticket, status: "已解决" };

    const response = await patch({
      action: "reject",
      status: "待再次处理",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组",
      reason: ""
    });

    expect(response.status).toBe(400);
  });

  it("queues a WeChat solved receipt when resolving a ticket", async () => {
    store.state!.tickets[0] = {
      ...ticket,
      status: "处理中",
      handlerId: "member-13700137000",
      handlerName: "搭建王工",
      reporterChatIdentityId: "chat-1",
      sourceConversationId: "conv-site"
    };

    const response = await patch({
      action: "progress",
      status: "已解决",
      actorId: "member-13700137000",
      actorName: "搭建王工",
      actorGroupName: "搭建组",
      processBody: "已加固门头并复核稳定性",
      imageUrls: ["data:image/jpeg;base64,abc"]
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.at(-1)).toMatchObject({
      targetConversationId: "conv-site",
      relatedTicketId: "ticket-1",
      status: "pending"
    });
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("工单已解决");
  });

  it("queues a WeChat close receipt when accepting a ticket", async () => {
    store.state!.tickets[0] = {
      ...ticket,
      status: "已解决",
      reporterChatIdentityId: "chat-1",
      sourceConversationId: "conv-site"
    };

    const response = await patch({
      action: "accept",
      status: "已关闭",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组"
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("工单已关闭");
  });

  it("queues a WeChat rework receipt when rejecting acceptance", async () => {
    store.state!.tickets[0] = {
      ...ticket,
      status: "已解决",
      reporterChatIdentityId: "chat-1",
      sourceConversationId: "conv-site"
    };

    const response = await patch({
      action: "reject",
      status: "待再次处理",
      actorId: "member-13600136000",
      actorName: "业务李经理",
      actorGroupName: "业务组",
      reason: "门头边角仍有松动，需要重新加固"
    });

    expect(response.status).toBe(200);
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("工单验收未通过");
    expect(store.state!.outboundMessages?.at(-1)?.text).toContain("门头边角仍有松动");
  });
});
