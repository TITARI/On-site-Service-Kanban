import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketList } from "@/components/ticket-list";
import type { Ticket } from "@/lib/domain/types";

const ticket: Ticket = {
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
  feedbackUsers: [{ userId: "member-13800138000", userName: "张三", phone: "13800138000", feedbackAt: "2026-05-21T08:00:00.000Z" }],
  status: "待受理",
  handlerName: "网络值班",
  assignmentGroup: "网络组",
  urgeCount: 1,
  lastUrgedAt: "2026-05-22T06:40:00.000Z",
  urgeLevel: 1,
  priorityScore: 55,
  aiDecisions: [],
  replies: [],
  timeline: [{ id: "timeline-1", ticketId: "ticket-1", type: "submitted", body: "网络断了，扫码失败", createdAt: "2026-05-22T06:32:00.000Z", actorName: "张三" }],
  createdAt: "2026-05-22T06:32:00.000Z",
  updatedAt: "2026-05-22T06:42:00.000Z"
};

describe("TicketList", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows ticket submit and urge times without year", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T04:00:00.000Z"));

    render(<TicketList tickets={[ticket]} onSelect={vi.fn()} />);

    expect(screen.getByText("提交 14:32")).not.toBeNull();
    expect(screen.getByText("催单 14:40")).not.toBeNull();
    expect(screen.queryByText(/2026/)).toBeNull();
  });
});
