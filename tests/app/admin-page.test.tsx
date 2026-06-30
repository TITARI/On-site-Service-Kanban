import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPage from "@/app/admin/page";
import type { AppConfig } from "@/lib/seed";
import { renderWithQueryClient } from "../helpers/query-client";

const config: AppConfig = {
  issueTypes: [
    { id: "network", name: "Network", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "Builder", enabled: true }
  ],
  aiModels: [
    { id: "fast", label: "快速智能模型", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高阶智能模型", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  messageIntegrations: [
    { id: "wechat", channel: "wechat", label: "WeChat MCP", enabled: false, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false },
    { id: "wecom", channel: "wecom", label: "WeCom MCP", enabled: true, mcpServerName: "wecom-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECOM_MCP_SECRET", autoCreateTickets: false }
  ],
  userGroups: [
    { id: "business", name: "Business", description: "Business users", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "Builder", description: "Builders", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
  ],
  assignmentRules: []
};

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function adminSessionResponse(authenticated = false, bootstrapRequired = false) {
  return new Response(JSON.stringify(
    authenticated
      ? {
          authenticated: true,
          user: {
            id: "person-admin",
            name: "Admin",
            phone: "13800138000",
            role: "admin"
          }
        }
      : { authenticated: false, bootstrapRequired }
  ), { status: 200 });
}

function adminBootstrapResponse() {
  return new Response(JSON.stringify({
    tickets: [],
    booths: [],
    messageRecords: [],
    people: [],
    chatIdentities: [],
    conversations: [],
    pendingWorkOrderSessions: [],
    outboundMessages: [],
    config
  }), { status: 200 });
}

function mockAdminFetch(initialSession: Response) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/session?type=admin") return initialSession.clone();
    if (url === "/api/admin/auth/login") return adminSessionResponse(true, false);
    if (url === "/api/admin/auth/bootstrap") return adminSessionResponse(true, false);
    if (url === "/api/admin/auth/logout") return new Response(JSON.stringify({ ok: true }), { status: 200 });
    if (url === "/api/bootstrap") return adminBootstrapResponse();
    if (url.includes("/api/admin/wechat-order-logs")) {
      return new Response(JSON.stringify({ logs: [] }), { status: 200 });
    }
    if (url.includes("/api/admin/wxauto-mcp")) {
      return new Response(JSON.stringify({ wxautoMcp: { enabled: false } }), { status: 200 });
    }
    return new Response(null, { status: 404 });
  });
}

describe("admin page login", () => {
  it("checks the server admin session before showing the password login form", async () => {
    const fetchMock = mockAdminFetch(adminSessionResponse(false, false));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<AdminPage />);

    expect(await screen.findByText("后台配置登录")).not.toBeNull();
    expect(screen.getByLabelText("管理员手机号")).not.toBeNull();
    expect(screen.getByLabelText("管理员密码")).not.toBeNull();
    expect(screen.queryByText("配置总览")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/session?type=admin",
      expect.objectContaining({ cache: "no-store", signal: expect.anything() })
    );
  });

  it("renders the first-admin bootstrap form when the server requires bootstrap", async () => {
    const fetchMock = mockAdminFetch(adminSessionResponse(false, true));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<AdminPage />);

    expect(await screen.findByText("首个管理员初始化")).not.toBeNull();
    expect(screen.getByLabelText("初始化旧口令")).not.toBeNull();
    expect(screen.getByLabelText("管理员密码")).not.toBeNull();
    expect(screen.queryByText("配置总览")).toBeNull();
  });

  it("opens the config center after server password login succeeds", async () => {
    const fetchMock = mockAdminFetch(adminSessionResponse(false, false));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithQueryClient(<AdminPage />);

    await user.type(await screen.findByLabelText("管理员手机号"), "13800138000");
    await user.type(screen.getByLabelText("管理员密码"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "进入后台" }));

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(localStorage.length).toBe(0);
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/login", expect.objectContaining({
      method: "POST"
    }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/bootstrap",
      expect.objectContaining({ cache: "no-store", signal: expect.anything() })
    ));
    expect(screen.queryByText("微信/企微消息")).toBeNull();
    expect(screen.queryByText("出站通知")).toBeNull();
  });

  it("shows a login error when a successful response omits the user", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/session?type=admin") return adminSessionResponse(false, false);
      if (url === "/api/admin/auth/login") return new Response(JSON.stringify({}), { status: 200 });
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithQueryClient(<AdminPage />);

    await user.type(await screen.findByLabelText("管理员手机号"), "13800138000");
    await user.type(screen.getByLabelText("管理员密码"), "new-password-123");
    await user.click(screen.getByRole("button", { name: "进入后台" }));

    expect(await screen.findByText("后台登录失败")).not.toBeNull();
  });

  it("opens the config center after first-admin bootstrap succeeds", async () => {
    const fetchMock = mockAdminFetch(adminSessionResponse(false, true));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    renderWithQueryClient(<AdminPage />);

    await user.type(await screen.findByLabelText("初始化旧口令"), "admin123");
    await user.type(screen.getByLabelText("管理员姓名"), "Admin");
    await user.type(screen.getByLabelText("管理员手机号"), "13800138000");
    await user.type(screen.getByLabelText("管理员密码"), "new-password-123");
    expect((screen.getByLabelText("管理员分组") as HTMLInputElement).value).toBe("管理员");
    await user.click(screen.getByRole("button", { name: "创建管理员" }));

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/bootstrap", expect.objectContaining({
      method: "POST"
    }));
  });

  it("loads the config center when the server reports an authenticated admin session", async () => {
    const fetchMock = mockAdminFetch(adminSessionResponse(true, false));
    vi.stubGlobal("fetch", fetchMock);

    renderWithQueryClient(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(screen.queryByText("后台配置登录")).toBeNull();
  });
});
