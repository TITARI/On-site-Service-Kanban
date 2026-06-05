import { describe, expect, it } from "vitest";
import { createTicketService } from "@/lib/services/ticket-service";
import { defaultConfig } from "@/lib/seed";

function state() {
  return {
    booths: [{ boothNumber: "A01", companyName: "上海星河科技有限公司", companyShortName: "星河科技", salesOwner: "王宁", builder: "青木搭建" }],
    tickets: [],
    messageRecords: [],
    config: defaultConfig()
  };
}

describe("ticket service", () => {
  it("creates a new ticket with generated title and accepted booth data", async () => {
    const service = createTicketService({ state: state() });

    const result = await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(result.kind).toBe("created");
    expect(result.ticket.title).toBe("A01 星河科技 网络");
    expect(result.ticket.status).toBe("待受理");
  });

  it("stores contact phone for the submitter and duplicate feedback users", async () => {
    const service = createTicketService({ state: state() });

    const first = await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三",
      submitterPhone: "13800138000"
    });

    const second = await service.submitTicket({
      boothNumber: "A01",
      description: "网络完全断开，扫码收款失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u2",
      submitterName: "李四",
      submitterPhone: "13900139000"
    });

    expect(first.ticket.submitterPhone).toBe("13800138000");
    expect(first.ticket.feedbackUsers[0]?.phone).toBe("13800138000");
    expect(second.ticket.feedbackUsers).toContainEqual(expect.objectContaining({ userName: "李四", phone: "13900139000" }));
  });

  it("turns high confidence same-booth duplicate into an urge", async () => {
    const service = createTicketService({ state: state() });

    await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    const second = await service.submitTicket({
      boothNumber: "A01",
      description: "网络完全断开，扫码收款失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u2",
      submitterName: "李四"
    });

    expect(second.kind).toBe("urged");
    expect(second.ticket.urgeCount).toBe(1);
    expect(second.ticket.feedbackUsers.map((user) => user.userName)).toContain("李四");
  });

  it("updates an existing feedback user instead of duplicating them on repeated urges", async () => {
    const appState = state();
    const service = createTicketService({ state: appState });

    await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });
    await service.submitTicket({
      boothNumber: "A01",
      description: "网络完全断开，扫码收款失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u2",
      submitterName: "李四"
    });
    const third = await service.submitTicket({
      boothNumber: "A01",
      description: "网络还是断开，扫码收款失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u2",
      submitterName: "李四"
    });

    expect(third.ticket.urgeCount).toBe(2);
    expect(third.ticket.feedbackUsers.filter((user) => user.userId === "u2")).toHaveLength(1);
    expect(third.ticket.timeline.filter((item) => item.type === "urged")).toHaveLength(2);
    expect(third.ticket.aiDecisions.at(-1)?.action).toBe("urge");
  });

  it("keeps automatically assigned tickets pending while recording the assignment timeline", async () => {
    const service = createTicketService({ state: state() });

    const result = await service.submitTicket({
      boothNumber: "A01",
      description: "网络断了，收银扫码失败",
      imageUrls: [],
      issueType: "自动",
      submitterId: "u1",
      submitterName: "张三"
    });

    expect(result.ticket.status).toBe("待受理");
    expect(result.ticket.handlerName).toBe("网络值班");
    expect(result.ticket.timeline.map((item) => item.type)).toContain("assigned");
  });
});
