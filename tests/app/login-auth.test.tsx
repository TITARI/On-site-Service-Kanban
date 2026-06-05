import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import userEvent from "@testing-library/user-event";
import HomePage from "@/app/page";
import * as auth from "@/lib/client/auth";
import type { Ticket } from "@/lib/domain/types";
import type { AppConfig } from "@/lib/seed";

const config: AppConfig = {
  issueTypes: [{ id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "网络组", enabled: true }],
  aiModels: [
    { id: "fast", label: "快速AI", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高智商AI", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  userGroups: [
    { id: "business", name: "业务组", description: "业务人员验收", canClaim: false, canProcess: false, canAccept: true, enabled: true },
    { id: "organizer", name: "主场组", description: "主场运营验收", canClaim: false, canProcess: false, canAccept: true, enabled: true },
    { id: "builder", name: "搭建组", description: "认领并处理现场搭建问题", canClaim: true, canProcess: true, canAccept: false, enabled: true }
  ],
  assignmentRules: []
};

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

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("login and role access", () => {
  it("does not read browser login state while rendering the server shell", () => {
    const readStoredUser = vi.spyOn(auth, "readStoredUser").mockReturnValue(null);

    const html = renderToString(<HomePage />);

    expect(readStoredUser).not.toHaveBeenCalled();
    expect(html).toContain("加载中");
    expect(html).not.toContain("登录后使用工单中心");
  });

  it("loads configured user groups before member login", async () => {
    const loginConfig: AppConfig = {
      ...config,
      userGroups: [
        ...(config.userGroups ?? []),
        {
          id: "management",
          name: "Dynamic Management Group",
          description: "Configured in admin",
          canClaim: true,
          canProcess: true,
          canAccept: true,
          enabled: true
        }
      ]
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ config: loginConfig }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<HomePage />);

    expect(await screen.findByRole("option", { name: "Dynamic Management Group" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap?scope=login", { cache: "no-store" });
  });

  it("requires a member to enter real name, phone and group before using the board", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tickets: [ticket], config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<HomePage />);

    const loginTitle = await screen.findByText("登录后使用工单中心");
    expect(loginTitle).not.toBeNull();
    expect(loginTitle.className).toContain("auth-title-single-line");
    expect(screen.queryByRole("button", { name: "管理员登录" })).toBeNull();
    expect(screen.queryByLabelText("管理口令")).toBeNull();
    expect(screen.getByRole("combobox", { name: "用户分组" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "业务组" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "主场组" })).not.toBeNull();
    expect(screen.getByRole("option", { name: "搭建组" })).not.toBeNull();

    await user.type(screen.getByLabelText("真实姓名"), "张三");
    await user.type(screen.getByLabelText("联系电话"), "13800138000");
    await user.selectOptions(screen.getByLabelText("用户分组"), "builder");
    await user.click(screen.getByRole("button", { name: "进入看板" }));

    expect(await screen.findByText("内部工单看板")).not.toBeNull();
    const currentUser = screen.getByLabelText("当前登录用户");
    const group = within(currentUser).getByText("搭建组");
    const identity = within(currentUser).getByText("张三 · 13800138000");
    const currentUserText = currentUser.textContent ?? "";
    expect(currentUserText.indexOf(group.textContent ?? "")).toBeLessThan(currentUserText.indexOf(identity.textContent ?? ""));
    expect(screen.queryByRole("button", { name: "管理" })).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
