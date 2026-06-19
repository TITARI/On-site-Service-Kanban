import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TicketDetail } from "@/components/ticket-detail";
import HomePage from "@/app/page";
import type { CurrentUser } from "@/lib/client/auth";
import type { Ticket } from "@/lib/domain/types";

const builderUser: CurrentUser = {
  id: "member-13700137000",
  name: "搭建王工",
  phone: "13700137000",
  role: "member",
  groupId: "builder",
  groupName: "搭建组",
  permissions: { canClaim: true, canProcess: true, canAccept: false }
};

const businessUser: CurrentUser = {
  id: "member-13600136000",
  name: "业务李经理",
  phone: "13600136000",
  role: "member",
  groupId: "business",
  groupName: "业务组",
  permissions: { canClaim: false, canProcess: false, canAccept: true }
};

const ticket: Ticket = {
  id: "ticket-1",
  title: "A01 星河科技 搭建",
  boothNumber: "A01",
  companyName: "上海星河科技有限公司",
  companyShortName: "星河科技",
  description: "门头结构松动，需要处理",
  imageUrls: ["data:image/png;base64,aW1hZ2U="],
  issueType: "搭建",
  submitterId: "mobile-user",
  submitterName: "现场成员",
  submitterPhone: "13800138000",
  feedbackUsers: [
    { userId: "mobile-user", userName: "现场成员", phone: "13800138000", feedbackAt: "2026-05-21T08:00:00.000Z" },
    { userId: "u2", userName: "巡场同事", phone: "13900139000", feedbackAt: "2026-05-21T08:05:00.000Z" }
  ],
  status: "待受理",
  assignmentGroup: "搭建组",
  urgeCount: 1,
  urgeLevel: 1,
  priorityScore: 95,
  aiDecisions: [],
  replies: [],
  timeline: [{ id: "timeline-1", ticketId: "ticket-1", type: "submitted", body: "门头结构松动，需要处理", createdAt: "2026-05-21T08:00:00.000Z", actorName: "现场成员" }],
  createdAt: "2026-05-21T08:00:00.000Z",
  updatedAt: "2026-05-21T08:00:00.000Z"
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

const pageConfig = {
  issueTypes: [{ id: "build", name: "搭建", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "搭建组", enabled: true }],
  aiModels: [],
  userGroups: [{
    id: "builder",
    name: "搭建组",
    description: "",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }],
  assignmentRules: []
};

function pageFetchForTicketMutation(mutationPath: string) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/session?type=mobile") {
      return new Response(JSON.stringify({ user: builderUser }), { status: 200 });
    }
    if (url === "/api/bootstrap?scope=mobile") {
      return new Response(JSON.stringify({ tickets: [ticket], config: pageConfig }), { status: 200 });
    }
    if (url === "/api/bootstrap?scope=login") {
      return new Response(JSON.stringify({ config: pageConfig }), { status: 200 });
    }
    if (url === `/api/tickets/${ticket.id}` && init?.method !== "PATCH") {
      return new Response(JSON.stringify({ ticket }), { status: 200 });
    }
    if (url === mutationPath) {
      return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
    }
    return new Response(null, { status: 404 });
  });
}

describe("TicketDetail", () => {
  it("exposes a level-one heading for the detail route", () => {
    render(<TicketDetail ticket={ticket} onRefresh={vi.fn()} />);

    expect(screen.getByRole("heading", { level: 1, name: "工单详情" })).not.toBeNull();
  });

  it("shows readonly people, Chinese priority and attached images", () => {
    render(<TicketDetail ticket={ticket} onRefresh={vi.fn()} />);

    expect(screen.getByText("紧急")).not.toBeNull();
    expect(screen.getByAltText("工单图片 1")).not.toBeNull();

    const people = within(screen.getByLabelText("相关人员"));
    expect(people.getByText("提交人")).not.toBeNull();
    expect(people.getAllByText("现场成员 · 13800138000").length).toBeGreaterThan(0);
    expect(people.getByText("巡场同事 · 13900139000")).not.toBeNull();
    expect(people.getByText("待派单")).not.toBeNull();
    expect(people.getByText("搭建组")).not.toBeNull();
    expect(people.queryByRole("textbox")).toBeNull();
    expect(people.queryByRole("button")).toBeNull();
  });

  it("shows ticket, feedback, timeline and reply times without year", () => {
    render(
      <TicketDetail
        ticket={{
          ...ticket,
          status: "处理中",
          acceptedAt: "2026-05-21T08:10:00.000Z",
          updatedAt: "2026-05-21T08:30:00.000Z",
          replies: [{
            id: "reply-1",
            ticketId: ticket.id,
            authorId: builderUser.id,
            authorName: builderUser.name,
            authorPhone: builderUser.phone,
            role: "handler",
            body: "已加固门头并复核稳定性",
            imageUrls: [],
            createdAt: "2026-05-21T08:20:00.000Z"
          }]
        }}
        onRefresh={vi.fn()}
      />
    );

    const timeInfo = screen.getByLabelText("工单时间信息");
    const timeLabels = Array.from(timeInfo.querySelectorAll("dt")).map((item) => item.textContent);
    expect(timeInfo.className).toContain("detail-time-grid-single-line");
    expect(timeLabels).toEqual(["提交时间", "受理时间", "更新时间"]);
    expect(within(timeInfo).getByText("05-21 16:00")).not.toBeNull();
    expect(within(timeInfo).getByText("05-21 16:10")).not.toBeNull();
    expect(within(timeInfo).getByText("05-21 16:30")).not.toBeNull();

    expect(within(screen.getByLabelText("相关人员")).getByText("05-21 16:05")).not.toBeNull();
    expect(within(screen.getByLabelText("处理记录")).getByText("05-21 16:00")).not.toBeNull();
    expect(within(screen.getByLabelText("回复与处理记录")).getByText("05-21 16:20")).not.toBeNull();
    expect(screen.queryByText(/2026/)).toBeNull();
  });

  it("keeps repeated detail facts in a single compact place", () => {
    render(<TicketDetail ticket={ticket} onRefresh={vi.fn()} />);

    const timeInfo = screen.getByLabelText("工单时间信息");
    const progress = screen.getByLabelText("工单处理进度");
    const people = screen.getByLabelText("相关人员");
    expect(screen.queryByText("A01 · 搭建")).toBeNull();
    expect(within(progress).getByText("催单 1次")).not.toBeNull();
    expect(within(timeInfo).queryByText("催单")).toBeNull();
    expect(within(timeInfo).queryByText("反馈")).toBeNull();
    expect(within(timeInfo).queryByText("处理人")).toBeNull();
    expect(within(timeInfo).queryByText("处理组")).toBeNull();
    expect(within(people).getByText("处理组")).not.toBeNull();
    expect(within(people).getByText("反馈用户 2人")).not.toBeNull();
  });

  it("shows only required workflow progress steps before the long detail sections", () => {
    render(<TicketDetail ticket={{ ...ticket, status: "处理中" }} onRefresh={vi.fn()} />);

    const progress = screen.getByLabelText("工单处理进度");
    const steps = within(progress).getByLabelText("进度节点");
    expect(within(progress).getByText("待受理")).not.toBeNull();
    expect(within(progress).getByText("处理中")).not.toBeNull();
    expect(within(progress).getByText("已解决")).not.toBeNull();
    expect(within(progress).getByText("已关闭")).not.toBeNull();
    expect(within(progress).queryByText("挂起")).toBeNull();
    expect(within(progress).queryByText("待再次处理")).toBeNull();
    expect(within(progress).queryByText("当前走到：处理中")).toBeNull();
    expect(within(progress).getByText("催单 1次")).not.toBeNull();
    expect(steps.getAttribute("data-progress-count")).toBe("4");
  });

  it("shows optional workflow steps only when the ticket needs them", () => {
    const reworkTimeline = [
      ...ticket.timeline,
      { id: "timeline-reject", ticketId: ticket.id, type: "receipt" as const, body: "业务组验收未通过：需要重新加固", createdAt: "2026-05-21T08:30:00.000Z", actorName: "业务李经理" }
    ];
    const { rerender } = render(<TicketDetail ticket={{ ...ticket, status: "待再次处理", timeline: reworkTimeline }} onRefresh={vi.fn()} />);

    let progress = screen.getByLabelText("工单处理进度");
    let steps = within(progress).getByLabelText("进度节点");
    expect(within(progress).getByText("待再次处理")).not.toBeNull();
    expect(within(progress).queryByText("挂起")).toBeNull();
    expect(steps.getAttribute("data-progress-count")).toBe("5");

    rerender(<TicketDetail ticket={{ ...ticket, status: "挂起", timeline: [{ ...ticket.timeline[0], body: "状态变更为挂起：等待物料" }] }} onRefresh={vi.fn()} />);

    progress = screen.getByLabelText("工单处理进度");
    steps = within(progress).getByLabelText("进度节点");
    expect(within(progress).getByText("挂起")).not.toBeNull();
    expect(within(progress).queryByText("待再次处理")).toBeNull();
    expect(steps.getAttribute("data-progress-count")).toBe("5");
  });

  it("shows processing reply photos in ticket detail", () => {
    render(
      <TicketDetail
        ticket={{
          ...ticket,
          status: "已解决",
          replies: [{
            id: "reply-1",
            ticketId: ticket.id,
            authorId: builderUser.id,
            authorName: builderUser.name,
            authorPhone: builderUser.phone,
            role: "handler",
            body: "已加固门头并复核稳定性",
            imageUrls: ["data:image/jpeg;base64,abc"],
            createdAt: "2026-05-21T08:20:00.000Z"
          }]
        }}
        onRefresh={vi.fn()}
      />
    );

    const replies = screen.getByLabelText("回复与处理记录");
    expect(within(replies).getByText("搭建王工")).not.toBeNull();
    expect(within(replies).getByText("已加固门头并复核稳定性")).not.toBeNull();
    expect(within(replies).getByAltText("处理记录图片 1")).not.toBeNull();
  });

  it("opens detail images in a full-screen viewer with navigation and swipe", async () => {
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, imageUrls: ["data:image/png;base64,one", "data:image/png;base64,two"] }} onRefresh={vi.fn()} />);

    const openButton = screen.getByRole("button", { name: "查看工单图片 1" });
    await user.click(openButton);

    const viewer = screen.getByRole("dialog", { name: "图片预览" });
    const closeButton = within(viewer).getByRole("button", { name: "关闭图片预览" });
    await waitFor(() => expect(document.activeElement).toBe(closeButton));
    await user.tab({ shift: true });
    expect(viewer.contains(document.activeElement)).toBe(true);
    expect(within(viewer).getByText("工单图片")).not.toBeNull();
    expect(within(viewer).getByText("1 / 2")).not.toBeNull();
    const firstPreview = within(viewer).getByAltText("工单图片预览 1");
    expect(firstPreview).not.toBeNull();

    await user.click(within(viewer).getByRole("button", { name: "右转" }));
    expect(firstPreview.getAttribute("style")).toContain("rotate(90deg)");

    await user.click(within(viewer).getByRole("button", { name: "下一张" }));
    expect(within(viewer).getByText("2 / 2")).not.toBeNull();
    const secondPreview = within(viewer).getByAltText("工单图片预览 2");
    expect(secondPreview).not.toBeNull();
    expect(secondPreview.getAttribute("style")).toContain("rotate(0deg)");

    const stage = within(viewer).getByLabelText("图片滑动区域");
    fireEvent.touchStart(stage, { touches: [{ clientX: 220 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 20 }] });
    expect(within(viewer).getByText("1 / 2")).not.toBeNull();
    expect(within(viewer).getByAltText("工单图片预览 1").getAttribute("style")).toContain("rotate(90deg)");

    await user.click(within(viewer).getByRole("button", { name: "左转" }));
    expect(within(viewer).getByAltText("工单图片预览 1").getAttribute("style")).toContain("rotate(0deg)");

    await user.click(closeButton);
    expect(screen.queryByRole("dialog", { name: "图片预览" })).toBeNull();
    expect(document.activeElement).toBe(openButton);
  });

  it("keeps the full image fit first and lets zoomed images pan instead of navigating", async () => {
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, imageUrls: ["data:image/png;base64,one", "data:image/png;base64,two"] }} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看工单图片 1" }));

    const viewer = screen.getByRole("dialog", { name: "图片预览" });
    const stage = within(viewer).getByLabelText("图片滑动区域");
    const zoomSurface = within(stage).getByTestId("image-viewer-zoom-surface");

    expect(stage.getAttribute("data-zoomed")).toBe("false");
    expect(zoomSurface.getAttribute("style")).toContain("width: 100%");
    expect(zoomSurface.getAttribute("style")).toContain("height: 100%");

    await user.click(within(viewer).getByRole("button", { name: "放大图片" }));

    expect(within(viewer).getByText("150%")).not.toBeNull();
    expect(stage.getAttribute("data-zoomed")).toBe("true");
    expect(zoomSurface.getAttribute("style")).toContain("width: 150%");
    expect(zoomSurface.getAttribute("style")).toContain("height: 150%");
    const tools = viewer.querySelector(".image-viewer-tools") as HTMLElement;
    expect(tools).not.toBeNull();
    expect(within(tools).getByRole("button", { name: "缩小图片" })).not.toBeNull();
    expect(within(tools).getByRole("button", { name: "适应全图" })).not.toBeNull();
    expect(within(tools).getByRole("button", { name: "放大图片" })).not.toBeNull();

    fireEvent.touchStart(stage, { touches: [{ clientX: 220 }] });
    fireEvent.touchEnd(stage, { changedTouches: [{ clientX: 20 }] });
    expect(within(viewer).getByText("1 / 2")).not.toBeNull();

    await user.click(within(viewer).getByRole("button", { name: "适应全图" }));

    expect(within(viewer).getByText("100%")).not.toBeNull();
    expect(stage.getAttribute("data-zoomed")).toBe("false");
    expect(zoomSurface.getAttribute("style")).toContain("width: 100%");
    expect(zoomSurface.getAttribute("style")).toContain("height: 100%");
  });

  it("places the viewer title above the centered image and the controls below it", async () => {
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, imageUrls: ["data:image/png;base64,one"] }} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看工单图片 1" }));

    const viewer = screen.getByRole("dialog", { name: "图片预览" });
    const panel = viewer.querySelector(".image-viewer-panel");
    expect(panel).not.toBeNull();
    expect(Array.from(panel!.children).map((child) => child.className)).toEqual([
      "image-viewer-head",
      "image-viewer-body",
      "image-viewer-tools"
    ]);
  });

  it("renders the full-screen viewer outside the detail card so mobile browsers do not constrain it", async () => {
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, imageUrls: ["data:image/png;base64,one"] }} onRefresh={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "查看工单图片 1" }));

    const viewer = screen.getByRole("dialog", { name: "图片预览" });
    const detailPanel = document.querySelector(".detail-panel");
    expect(detailPanel).not.toBeNull();
    expect(viewer.parentElement).toBe(document.body);
    expect(detailPanel!.contains(viewer)).toBe(false);
  });

  it("allows builder group users to claim a ticket", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: { ...ticket, status: "处理中" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onRefresh = vi.fn();

    render(<TicketDetail ticket={ticket} currentUser={builderUser} onRefresh={onRefresh} />);

    await userEvent.click(screen.getByRole("button", { name: "认领工单" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.action).toBe("claim");
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("actorName");
    expect(body).not.toHaveProperty("actorPhone");
    expect(body).not.toHaveProperty("actorGroupName");
    expect(body).not.toHaveProperty("handlerId");
    expect(body).not.toHaveProperty("handlerName");
    expect(body).not.toHaveProperty("handlerPhone");
    expect(onRefresh).toHaveBeenCalled();
  });

  it("requires builder progress updates to include processing content and photos", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: { ...ticket, status: "已解决" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, status: "处理中", handlerId: builderUser.id, handlerName: builderUser.name }} currentUser={builderUser} onRefresh={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText("下一进度"), "已解决");
    await user.type(screen.getByLabelText("处理内容"), "已加固门头并复核稳定性");
    await user.upload(screen.getByLabelText("处理照片"), new File(["done-image"], "处理.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "提交处理进度" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.action).toBe("progress");
    expect(body.status).toBe("已解决");
    expect(body.processBody).toBe("已加固门头并复核稳定性");
    expect(body.imageUrls[0]).toMatch(/^data:image\/jpeg;base64,/);
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("actorName");
    expect(body).not.toHaveProperty("actorPhone");
    expect(body).not.toHaveProperty("actorGroupName");
  });

  it("allows business or organizer group users to accept resolved tickets", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: { ...ticket, status: "已关闭" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<TicketDetail ticket={{ ...ticket, status: "已解决" }} currentUser={businessUser} onRefresh={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "验收通过" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.action).toBe("accept");
    expect(body.status).toBe("已关闭");
    expect(body).not.toHaveProperty("actorGroupName");
    expect(body).not.toHaveProperty("actorName");
  });

  it("allows business or organizer group users to reject resolved tickets for rework", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket: { ...ticket, status: "待再次处理" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<TicketDetail ticket={{ ...ticket, status: "已解决" }} currentUser={businessUser} onRefresh={vi.fn()} />);

    await user.type(screen.getByLabelText("未通过原因"), "门头边角仍有松动，需要重新加固");
    await user.click(screen.getByRole("button", { name: "验收未通过" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.action).toBe("reject");
    expect(body.status).toBe("待再次处理");
    expect(body.reason).toBe("门头边角仍有松动，需要重新加固");
    expect(body).not.toHaveProperty("actorGroupName");
    expect(body).not.toHaveProperty("actorName");
  });

  it("submits reply images with the reply payload", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<TicketDetail ticket={ticket} onRefresh={vi.fn()} />);

    await user.type(screen.getByRole("textbox", { name: "回复内容" }), "已通知网络组");
    await user.upload(screen.getByLabelText("回复图片"), new File(["reply-image"], "回复.jpg", { type: "image/jpeg" }));
    await user.click(screen.getByRole("button", { name: "回复" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.imageUrls).toHaveLength(1);
    expect(body.imageUrls[0]).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("sends replies without client author or role identity fields", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ticket }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<TicketDetail ticket={ticket} currentUser={builderUser} onRefresh={vi.fn()} />);

    expect(screen.queryByRole("textbox", { name: "回复人" })).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "回复内容" }), "现场已补充照片");
    await user.click(screen.getByRole("button", { name: "回复" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).not.toHaveProperty("authorId");
    expect(body).not.toHaveProperty("authorName");
    expect(body).not.toHaveProperty("authorPhone");
    expect(body).not.toHaveProperty("role");
    expect(body.body).toBe("现场已补充照片");
  });

  it("returns to login when a mobile fetch returns 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=mobile") {
        return new Response(JSON.stringify({ user: builderUser }), { status: 200 });
      }
      if (url === "/api/bootstrap?scope=mobile") {
        return new Response(JSON.stringify({ message: "未登录" }), { status: 401 });
      }
      if (url === "/api/bootstrap?scope=login") {
        return new Response(JSON.stringify({
          config: {
            issueTypes: [],
            aiModels: [],
            userGroups: [{
              id: "builder",
              name: "搭建组",
              description: "",
              canClaim: true,
              canProcess: true,
              canAccept: false,
              canAdmin: false,
              enabled: true
            }],
            assignmentRules: []
          }
        }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    expect(await screen.findByRole("button", { name: /进入|杩涘叆/ })).not.toBeNull();
    expect(screen.queryByText("搭建王工")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap?scope=login", { cache: "no-store" });
  });

  it("returns to login when ticket submit receives 401 and keeps submit payload business-only", async () => {
    const fetchMock = pageFetchForTicketMutation("/api/tickets");
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HomePage />);

    await screen.findByText("A01 星河科技 搭建");
    await user.click(screen.getByRole("button", { name: "提交" }));
    await user.type(screen.getByRole("textbox", { name: "展位号" }), "A01");
    await user.type(screen.getByRole("textbox", { name: "问题描述" }), "门头结构松动，需要处理");
    await user.click(screen.getByRole("button", { name: "提交工单" }));

    expect(await screen.findByRole("button", { name: /进入|杩涘叆/ })).not.toBeNull();
    expect(screen.queryByText("A01 星河科技 搭建")).toBeNull();
    expect(screen.queryByText("搭建王工")).toBeNull();
    const submitCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/tickets" && init?.method === "POST");
    const body = JSON.parse(String(submitCall?.[1]?.body));
    expect(body).not.toHaveProperty("submitterId");
    expect(body).not.toHaveProperty("submitterName");
    expect(body).not.toHaveProperty("submitterPhone");
  });

  it("returns to login when a ticket action receives 401 and keeps action payload business-only", async () => {
    const fetchMock = pageFetchForTicketMutation(`/api/tickets/${ticket.id}`);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HomePage />);

    await screen.findByText("A01 星河科技 搭建");
    await user.click(screen.getByRole("button", { name: /A01 星河科技 搭建/ }));
    await screen.findByRole("button", { name: "认领工单" });
    await user.click(screen.getByRole("button", { name: "认领工单" }));

    expect(await screen.findByRole("button", { name: /进入|杩涘叆/ })).not.toBeNull();
    expect(screen.queryByText("A01 星河科技 搭建")).toBeNull();
    expect(screen.queryByText("搭建王工")).toBeNull();
    const actionCall = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/tickets/${ticket.id}` && init?.method === "PATCH");
    const body = JSON.parse(String(actionCall?.[1]?.body));
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("actorName");
    expect(body).not.toHaveProperty("handlerId");
    expect(body).not.toHaveProperty("handlerName");
  });

  it("returns to login when a ticket reply receives 401 and keeps reply payload business-only", async () => {
    const fetchMock = pageFetchForTicketMutation(`/api/tickets/${ticket.id}/replies`);
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HomePage />);

    await screen.findByText("A01 星河科技 搭建");
    await user.click(screen.getByRole("button", { name: /A01 星河科技 搭建/ }));
    await screen.findByRole("textbox", { name: "回复内容" });
    await user.type(screen.getByRole("textbox", { name: "回复内容" }), "现场已补充照片");
    await user.click(screen.getByRole("button", { name: "回复" }));

    expect(await screen.findByRole("button", { name: /进入|杩涘叆/ })).not.toBeNull();
    expect(screen.queryByText("A01 星河科技 搭建")).toBeNull();
    expect(screen.queryByText("搭建王工")).toBeNull();
    const replyCall = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/tickets/${ticket.id}/replies` && init?.method === "POST");
    const body = JSON.parse(String(replyCall?.[1]?.body));
    expect(body).not.toHaveProperty("authorId");
    expect(body).not.toHaveProperty("authorName");
    expect(body).not.toHaveProperty("authorPhone");
    expect(body).not.toHaveProperty("role");
  });
});
