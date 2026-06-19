import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPage from "@/app/admin/page";
import AdminLogsPage from "@/app/admin/logs/page";
import AdminUsersPage from "@/app/admin/users/page";
import AdminWorkOrderSettingsPage from "@/app/admin/work-order-settings/page";
import AdminExhibitionDataPage from "@/app/admin/exhibition-data/page";
import AdminSystemPage from "@/app/admin/system/page";
import { defaultConfig } from "@/lib/seed";

const bootstrap = {
  tickets: [],
  booths: [
    { boothNumber: "A01", companyName: "星河科技", companyShortName: "星河", salesOwner: "王宁", builder: "搭建商" }
  ],
  messageRecords: [],
  people: [
    {
      id: "person-1",
      name: "张三",
      phone: "13800138000",
      role: "handler",
      groupName: "搭建组",
      enabled: true,
      createdAt: "2026-05-22T08:20:00.000Z",
      updatedAt: "2026-05-22T08:21:00.000Z"
    }
  ],
  chatIdentities: [
    {
      id: "chat-1",
      platform: "wechat",
      externalUserId: "wxid-zhangsan",
      displayName: "张三微信",
      personId: "person-1",
      verifiedBy: "phone",
      verifiedAt: "2026-05-22T08:21:00.000Z",
      firstSeenAt: "2026-05-22T08:20:00.000Z",
      lastSeenAt: "2026-05-22T08:21:00.000Z"
    }
  ],
  conversations: [
    {
      id: "conversation-1",
      platform: "wechat",
      type: "group",
      externalConversationId: "现场群",
      title: "现场保障群",
      linkedPersonIds: ["person-1"],
      defaultNotify: true,
      createdAt: "2026-05-22T08:20:00.000Z",
      updatedAt: "2026-05-22T08:22:00.000Z"
    }
  ],
  pendingWorkOrderSessions: [
    {
      id: "pending-1",
      platform: "wechat",
      conversationId: "conversation-1",
      chatIdentityId: "chat-1",
      draftText: "这里没电了，麻烦处理",
      draftImages: [],
      missingFields: ["boothNumber"],
      createdAt: "2026-05-22T08:21:00.000Z",
      updatedAt: "2026-05-22T08:22:00.000Z"
    }
  ],
  outboundMessages: [],
  config: defaultConfig()
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function authenticatedSession() {
  return new Response(JSON.stringify({
    authenticated: true,
    user: {
      id: "person-admin",
      name: "Admin",
      phone: "13800138000",
      role: "admin"
    }
  }), { status: 200 });
}

function unauthenticatedSession() {
  return new Response(JSON.stringify({
    authenticated: false,
    bootstrapRequired: false
  }), { status: 200 });
}

function mockBootstrapFetch(extra?: { logs?: unknown[] }) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/session?type=admin") return authenticatedSession();
    if (url === "/api/admin/auth/login") return authenticatedSession();
    if (url === "/api/admin/auth/logout") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/api/admin/wxauto-mcp")) {
      return new Response(JSON.stringify({
        wxautoMcp: {
          enabled: true,
          endpoint: "/api/mcp",
          accessToken: "test-token",
          tokenPreview: "test...oken",
          autoCreateTickets: false
        }
      }), { status: 200 });
    }
    if (url.includes("/api/admin/wechat-order-logs")) {
      return new Response(JSON.stringify({ logs: extra?.logs ?? [] }), { status: 200 });
    }
    return new Response(JSON.stringify(bootstrap), { status: 200 });
  });
}

async function renderWithSession(ui: React.ReactElement, fetchMock = mockBootstrapFetch()) {
  vi.stubGlobal("fetch", fetchMock);
  render(ui);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/session?type=admin", { cache: "no-store" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap", { cache: "no-store" }));
}

describe("admin subroutes", () => {
  it("uses the root admin route as a workbench with sidebar navigation", async () => {
    await renderWithSession(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(screen.getByRole("navigation", { name: "后台主导航" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "微信下单日志" }).getAttribute("href")).toBe("/admin/logs");
    expect(screen.getByRole("link", { name: "用户与权限" }).getAttribute("href")).toBe("/admin/users");
    expect(screen.getByRole("link", { name: "工单设置" }).getAttribute("href")).toBe("/admin/work-order-settings");
    expect(screen.getByRole("link", { name: "展览数据" }).getAttribute("href")).toBe("/admin/exhibition-data");
    expect(screen.getByRole("link", { name: "系统配置" }).getAttribute("href")).toBe("/admin/system");
    expect(screen.getByText("消息身份联通")).not.toBeNull();
    expect(screen.getByText("人员 1")).not.toBeNull();
    expect(screen.getByText("身份 1")).not.toBeNull();
    expect(screen.getByText("会话 1")).not.toBeNull();
    expect(screen.getByText("待补全 1")).not.toBeNull();
    expect(screen.getByText("这里没电了，麻烦处理")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "用户分组" })).toBeNull();
  });

  it("shows the user management route in backend navigation", async () => {
    await renderWithSession(<AdminPage />);

    expect(screen.getByRole("link", { name: "用户与权限" }).getAttribute("href")).toBe("/admin/users");
  });

  it("renders the WeChat order log route and loads log data", async () => {
    const fetchMock = mockBootstrapFetch({
      logs: [
        {
          id: "log-1",
          channel: "wechat",
          action: "create-ticket",
          ticketId: "ticket-1",
          summary: "已创建工单",
          status: "processed",
          createdAt: "2026-05-29T12:00:00.000Z"
        }
      ]
    });

    await renderWithSession(<AdminLogsPage />, fetchMock);

    expect((await screen.findAllByRole("heading", { name: "微信下单日志" })).length).toBeGreaterThan(0);
    expect(await screen.findByText("已创建工单")).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wechat-order-logs?limit=50", { cache: "no-store" }));
  });

  it("renders each backend subroute as a focused management page", async () => {
    await renderWithSession(<AdminWorkOrderSettingsPage />);
    expect(await screen.findByRole("heading", { name: "工单设置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存问题类型配置" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "智能接口" })).toBeNull();

    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    await renderWithSession(<AdminExhibitionDataPage />);
    expect((await screen.findAllByRole("heading", { name: "展览数据" })).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("导入展位数据文件")).not.toBeNull();

    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    await renderWithSession(<AdminSystemPage />);
    expect(await screen.findByRole("heading", { name: "系统配置" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "智能接口" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "wxauto 桌面服务" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存 wxauto 设置" })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "关键词配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "保存关键词配置" })).not.toBeNull();

    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
    await renderWithSession(<AdminUsersPage />);
    expect((await screen.findAllByRole("heading", { name: "用户与权限" })).length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "用户与权限管理" })).not.toBeNull();
  });

  it("loads the sidebar log badge count from the log API on management pages", async () => {
    const fetchMock = mockBootstrapFetch({
      logs: [
        {
          id: "log-1",
          channel: "wechat",
          action: "create-ticket",
          summary: "已创建工单",
          status: "processed",
          createdAt: "2026-05-29T12:00:00.000Z"
        },
        {
          id: "log-2",
          channel: "wechat",
          action: "needs-review",
          summary: "待人工确认",
          status: "pending",
          createdAt: "2026-05-29T12:01:00.000Z"
        }
      ]
    });

    await renderWithSession(<AdminSystemPage />, fetchMock);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/wechat-order-logs?limit=50", { cache: "no-store" }));
    const logLink = Array.from(document.querySelectorAll("a")).find((link) => link.getAttribute("href") === "/admin/logs");
    expect(logLink?.textContent).toContain("2");
  });

  it("keeps admin login protection on subroutes", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=admin") return unauthenticatedSession();
      if (url === "/api/admin/auth/login") return authenticatedSession();
      if (url.includes("/api/admin/wxauto-mcp")) {
        return new Response(JSON.stringify({ wxautoMcp: { enabled: false } }), { status: 200 });
      }
      if (url.includes("/api/admin/wechat-order-logs")) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(bootstrap), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminLogsPage />);

    expect(await screen.findByText("后台配置登录")).not.toBeNull();
    await user.type(screen.getByLabelText("管理员手机号"), "13800138000");
    await user.type(screen.getByLabelText("管理员密码"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "进入后台" }));

    expect(localStorage.length).toBe(0);
    expect((await screen.findAllByRole("heading", { name: "微信下单日志" })).length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/login", expect.objectContaining({
      method: "POST"
    }));
  });

  it("logs out through the server and returns to the admin login form", async () => {
    const fetchMock = mockBootstrapFetch();
    await renderWithSession(<AdminSystemPage />, fetchMock);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "退出后台" }));

    expect(await screen.findByText("后台配置登录")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/logout", expect.objectContaining({
      method: "POST"
    }));
  });
});
