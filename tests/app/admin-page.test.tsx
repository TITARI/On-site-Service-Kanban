import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPage from "@/app/admin/page";
import type { AppConfig } from "@/lib/seed";

const config: AppConfig = {
  issueTypes: [
    { id: "network", name: "网络", urgencyMinutes: 20, priorityWeight: 25, assignmentGroup: "搭建组", enabled: true }
  ],
  aiModels: [
    { id: "fast", label: "快速AI", provider: "mock", modelName: "fast-local", timeoutMs: 800, enabled: true },
    { id: "smart", label: "高智商AI", provider: "mock", modelName: "smart-local", timeoutMs: 3000, enabled: true }
  ],
  messageIntegrations: [
    { id: "wechat", channel: "wechat", label: "微信 MCP", enabled: false, mcpServerName: "wechat-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECHAT_MCP_SECRET", autoCreateTickets: false },
    { id: "wecom", channel: "wecom", label: "企业微信 MCP", enabled: true, mcpServerName: "wecom-mcp", endpoint: "/api/integrations/wechat/messages", secretEnv: "WECOM_MCP_SECRET", autoCreateTickets: false }
  ],
  userGroups: [
    { id: "business", name: "业务组", description: "业务人员验收", canClaim: false, canProcess: false, canAccept: true, canAdmin: false, enabled: true },
    { id: "builder", name: "搭建组", description: "认领并处理现场搭建问题", canClaim: true, canProcess: true, canAccept: false, canAdmin: false, enabled: true }
  ],
  assignmentRules: []
};

afterEach(() => {
  vi.unstubAllGlobals();
});

const adminActor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "系统管理员",
  phone: "13800138000",
  groupId: "admin",
  groupName: "系统管理员组",
  permissions: ["admin.access"],
  sessionType: "admin"
};

describe("admin page login", () => {
  it("requires backend login before showing the config center", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      authenticated: false,
      bootstrapRequired: false
    }), { status: 200 })));

    render(<AdminPage />);

    expect(await screen.findByText("后台账号登录")).not.toBeNull();
    expect(screen.getByLabelText("手机号")).not.toBeNull();
    expect(screen.getByLabelText("后台密码")).not.toBeNull();
    expect(screen.queryByText("配置总览")).toBeNull();
  });

  it("opens the config center after the admin password is accepted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({
          authenticated: false,
          bootstrapRequired: false
        }), { status: 200 });
      }
      if (url.includes("/api/admin/auth/login")) {
        return new Response(JSON.stringify({ user: adminActor }), { status: 200 });
      }
      if (url.includes("/api/admin/wechat-order-logs")) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [], config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPage />);

    await user.type(await screen.findByLabelText("手机号"), "13800138000");
    await user.type(screen.getByLabelText("后台密码"), "StrongPass123!");
    await user.click(screen.getByRole("button", { name: "进入后台" }));

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap", { cache: "no-store" }));
    expect(screen.queryByText("微信/企微消息")).toBeNull();
    expect(screen.queryByText("出站通知")).toBeNull();
  });

  it("loads the config center when a server admin session already exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({
          authenticated: true,
          user: adminActor
        }), { status: 200 });
      }
      if (url.includes("/api/admin/wechat-order-logs")) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [], config }), { status: 200 });
    }));

    render(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(screen.queryByText("后台账号登录")).toBeNull();
  });

  it("shows first-admin initialization and enters the backend after completion", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/session")) {
        return new Response(JSON.stringify({
          authenticated: false,
          bootstrapRequired: true
        }), { status: 200 });
      }
      if (url.includes("/api/bootstrap?scope=login")) {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      if (url.includes("/api/admin/auth/bootstrap")) {
        return new Response(JSON.stringify({ user: adminActor }), { status: 200 });
      }
      if (url.includes("/api/admin/wechat-order-logs")) {
        return new Response(JSON.stringify({ logs: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tickets: [], config }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPage />);

    expect(await screen.findByText("初始化后台管理员")).not.toBeNull();
    await user.type(screen.getByLabelText("原后台口令"), "admin123");
    await user.type(screen.getByLabelText("管理员姓名"), "系统管理员");
    await user.type(screen.getByLabelText("手机号"), "13800138000");
    await user.type(screen.getByLabelText("新后台密码"), "StrongPass123!");
    await user.click(screen.getByRole("button", { name: "创建管理员并进入后台" }));

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/auth/bootstrap",
      expect.objectContaining({ method: "POST" })
    );
  });
});
