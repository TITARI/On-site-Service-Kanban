import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AdminPage from "@/app/admin/page";
import { ADMIN_AUTH_STORAGE_KEY } from "@/lib/client/admin-auth";
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
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("admin page login", () => {
  it("requires backend login before showing the config center", async () => {
    vi.stubGlobal("fetch", vi.fn());

    render(<AdminPage />);

    expect(await screen.findByText("后台配置登录")).not.toBeNull();
    expect(screen.getByLabelText("后台口令")).not.toBeNull();
    expect(screen.queryByText("配置总览")).toBeNull();
  });

  it("opens the config center after the admin password is accepted", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tickets: [], config }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminPage />);

    await user.type(await screen.findByLabelText("后台口令"), "admin123");
    await user.click(screen.getByRole("button", { name: "进入后台" }));

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(localStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBe("active");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bootstrap", { cache: "no-store" }));
    expect(screen.queryByText("微信/企微消息")).toBeNull();
    expect(screen.queryByText("出站通知")).toBeNull();
  });

  it("loads the config center when an admin session already exists", async () => {
    localStorage.setItem(ADMIN_AUTH_STORAGE_KEY, "active");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ tickets: [], config }), { status: 200 })));

    render(<AdminPage />);

    expect(await screen.findByRole("heading", { name: "后台工作台" })).not.toBeNull();
    expect(screen.queryByText("后台配置登录")).toBeNull();
  });
});
