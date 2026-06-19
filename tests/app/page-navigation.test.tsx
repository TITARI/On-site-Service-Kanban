import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import HomePage from "@/app/page";
import type { CurrentUser } from "@/lib/client/auth";
import { ticketShortCode } from "@/lib/domain/ticket-links";
import type { Ticket } from "@/lib/domain/types";
import type { AppConfig } from "@/lib/seed";

const config: AppConfig = {
  issueTypes: [{ id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true }],
  aiModels: [
    { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  assignmentRules: []
};

const memberUser: CurrentUser = { id: "member-13800138000", name: "张三", phone: "13800138000", role: "member" };

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
  urgeLevel: 1,
  priorityScore: 55,
  aiDecisions: [],
  replies: [],
  timeline: [{ id: "timeline-1", ticketId: "ticket-1", type: "submitted", body: "网络断了，扫码失败", createdAt: "2026-05-21T08:00:00.000Z", actorName: "张三" }],
  createdAt: "2026-05-21T08:00:00.000Z",
  updatedAt: "2026-05-21T08:00:00.000Z"
};

function sessionResponse(user: CurrentUser = memberUser) {
  return new Response(JSON.stringify({ user }), { status: 200 });
}

afterEach(() => {
  localStorage.clear();
  window.history.pushState({}, "", "/");
  vi.unstubAllGlobals();
});

describe("home page ticket navigation", () => {
  it("keeps ticket detail on a second-level view", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") return sessionResponse();
      return new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 });
    }));

    render(<HomePage />);

    expect(await screen.findByText("今日 1")).not.toBeNull();
    expect(screen.getByText("紧急 0")).not.toBeNull();
    expect(screen.getByText("待受理 1")).not.toBeNull();

    const [rowTitle] = await screen.findAllByText("A01 星河科技 网络");
    expect(screen.getByText("点击进入详情")).not.toBeNull();
    expect(screen.queryByText("处理人")).toBeNull();

    await userEvent.click(rowTitle.closest("button")!);

    expect((await screen.findAllByText("处理人")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "返回工单列表" })).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "返回工单列表" }));

    expect(screen.queryByText("处理人")).toBeNull();
    expect(await screen.findByText("A01 星河科技 网络")).not.toBeNull();
  });

  it("loads full ticket details after selecting a mobile ticket summary", async () => {
    const { imageUrls, replies, timeline, aiDecisions, ...summary } = ticket;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") return sessionResponse();
      if (url.includes("/api/tickets/ticket-1")) {
        return new Response(JSON.stringify({ ticket }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [summary], config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    const [rowTitle] = await screen.findAllByText(ticket.title);
    await userEvent.click(rowTitle.closest("button")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/tickets/ticket-1", { cache: "no-store" }));
  });

  it("opens ticket details from a short ticket code query", async () => {
    window.history.pushState({}, "", `/?ticketCode=${ticketShortCode(ticket.id)}`);
    const { imageUrls, replies, timeline, aiDecisions, ...summary } = ticket;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") return sessionResponse();
      if (url.includes("/api/tickets/ticket-1")) {
        return new Response(JSON.stringify({ ticket }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [summary], config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/tickets/ticket-1", { cache: "no-store" }));
    expect((await screen.findAllByText("处理人")).length).toBeGreaterThan(0);
  });

  it("hides the immersive hero on ticket detail pages", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") return sessionResponse();
      return new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 });
    }));

    render(<HomePage />);

    expect(await screen.findByText("内部工单看板")).not.toBeNull();

    const [rowTitle] = await screen.findAllByText("A01 星河科技 网络");
    await userEvent.click(rowTitle.closest("button")!);

    expect(screen.queryByText("内部工单看板")).toBeNull();
    expect(screen.queryByLabelText("当前登录用户")).toBeNull();
  });

  it("ignores old mobile admin sessions", async () => {
    localStorage.setItem("internal-board-current-user", JSON.stringify({ id: "admin", name: "管理员", phone: "", role: "admin" }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      return new Response(JSON.stringify({ config }), { status: 200 });
    }));

    render(<HomePage />);

    expect(await screen.findByText("登录后使用工单中心")).not.toBeNull();
    expect(screen.queryByText("管理配置")).toBeNull();
    expect(screen.queryByRole("button", { name: "管理" })).toBeNull();
  });
});
