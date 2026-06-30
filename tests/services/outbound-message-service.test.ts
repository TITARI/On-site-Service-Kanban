import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import type { AppState } from "@/lib/storage/file-store";
import { defaultConfig } from "@/lib/seed";
import {
  claimPendingOutboundMessages,
  markOutboundMessageFailed,
  markOutboundMessageSent,
  queueOutboundMessage,
  queueProcessingGroupMessage
} from "@/lib/services/outbound-message-service";

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
    config: defaultConfig()
  };
}

describe("outbound message service", () => {
  it("queues pending WeChat messages", () => {
    const appState = state();

    const message = queueOutboundMessage(appState, {
      channel: "wechat",
      targetName: "搭建群",
      text: "A01 网络工单已创建",
      relatedTicketId: "ticket-1"
    });

    expect(message).toMatchObject({
      channel: "wechat",
      targetName: "搭建群",
      text: "A01 网络工单已创建",
      relatedTicketId: "ticket-1",
      status: "pending",
      retryCount: 0
    });
    expect(appState.outboundMessages).toHaveLength(1);
  });

  it("claims pending messages and marks them sending", () => {
    const appState = state();
    queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "请补充展位号" });

    const claimed = claimPendingOutboundMessages(appState, { limit: 1, now: "2026-05-27T12:00:00.000Z" });

    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe("sending");
    expect(claimed[0].claimedAt).toBe("2026-05-27T12:00:00.000Z");
  });

  it("marks sent and failed messages", () => {
    const appState = state();
    const message = queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "已创建工单" });

    markOutboundMessageSent(appState, message.id, "2026-05-27T12:01:00.000Z");
    expect(message.status).toBe("sent");
    expect(message.sentAt).toBe("2026-05-27T12:01:00.000Z");

    const failed = queueOutboundMessage(appState, { channel: "wechat", targetName: "李四", text: "发送失败测试" });
    markOutboundMessageFailed(appState, failed.id, "窗口不存在", "2026-05-27T12:02:00.000Z");

    expect(failed.status).toBe("failed");
    expect(failed.retryCount).toBe(1);
    expect(failed.lastError).toBe("窗口不存在");
  });

  it("does not regress a sent message when a stale failure callback arrives", () => {
    const appState = state();
    const message = queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "已创建工单" });
    markOutboundMessageSent(appState, message.id, "2026-05-27T12:01:00.000Z");

    markOutboundMessageFailed(appState, message.id, "迟到的失败回调", "2026-05-27T12:02:00.000Z");

    expect(message.status).toBe("sent");
    expect(message.retryCount).toBe(0);
    expect(message.lastError).toBeUndefined();
  });

  it("records BullMQ's minimum retry count on terminal failure", () => {
    const appState = state();
    const message = queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "发送失败测试" });

    markOutboundMessageFailed(appState, message.id, "重试耗尽", "2026-05-27T12:02:00.000Z", 3);
    markOutboundMessageFailed(appState, message.id, "重试耗尽", "2026-05-27T12:02:01.000Z", 3);

    expect(message.retryCount).toBe(3);
    expect(message.status).toBe("failed");
  });

  it("reclaims expired sending messages without claiming fresh ones", () => {
    const appState = state();
    const expired = queueOutboundMessage(appState, { channel: "wechat", targetName: "张三", text: "过期发送中" });
    const fresh = queueOutboundMessage(appState, { channel: "wechat", targetName: "李四", text: "新鲜发送中" });
    expired.status = "sending";
    expired.claimedAt = "2026-05-27T11:57:00.000Z";
    fresh.status = "sending";
    fresh.claimedAt = "2026-05-27T11:59:30.000Z";

    const claimed = claimPendingOutboundMessages(appState, {
      limit: 10,
      now: "2026-05-27T12:00:00.000Z",
      claimTimeoutMs: 120000
    });

    expect(claimed.map((message) => message.id)).toEqual([expired.id]);
    expect(expired.claimedAt).toBe("2026-05-27T12:00:00.000Z");
    expect(fresh.claimedAt).toBe("2026-05-27T11:59:30.000Z");
  });

  it("targets the configured WeChat conversation for the processing group", () => {
    const appState = state();
    appState.config.processingGroupConversations = [
      { groupId: "搭建组", wechatConversationId: "wechat-group-builder" }
    ];

    const message = queueProcessingGroupMessage(appState, {
      id: "ticket-builder",
      assignmentGroup: "搭建组"
    } as Ticket, "新工单：A01 星河科技 搭建");

    expect(message.targetConversationId).toBe("wechat-group-builder");
    expect(message.targetName).toBe("搭建组");
  });

  it("leaves the conversation target undefined when the processing group has no mapping", () => {
    const appState = state();

    const message = queueProcessingGroupMessage(appState, {
      id: "ticket-unmapped",
      assignmentGroup: "未配置组"
    } as Ticket, "新工单：A01 星河科技 网络");

    expect(message.targetConversationId).toBeUndefined();
    expect(message.targetName).toBe("未配置组");
  });

  it("uses the generic processing group fallback target name", () => {
    const appState = state();

    const message = queueProcessingGroupMessage(appState, {
      id: "ticket-no-assignee",
      title: "T01 测试科技 电力",
      description: "018特装电路有问题，处理一下",
    } as Ticket, "新工单：T01 测试科技 电力");

    expect(message.targetName).toBe("处理组");
  });
});
