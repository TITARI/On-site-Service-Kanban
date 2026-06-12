import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { UserListItem } from "@/lib/domain/access-control";
import type { UserGroup } from "@/lib/domain/types";

const groups: UserGroup[] = [
  {
    id: "builder",
    name: "搭建组",
    description: "处理现场问题",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  },
  {
    id: "admin",
    name: "系统管理员组",
    description: "管理系统配置",
    canClaim: true,
    canProcess: true,
    canAccept: true,
    canAdmin: true,
    enabled: true
  }
];

const builder: UserListItem = {
  personId: "person-1",
  accountId: "account-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  groupLocked: false,
  enabled: true,
  permissions: ["ticket.claim", "ticket.process"],
  hasPassword: false,
  lastLoginAt: "2026-06-11T08:00:00.000Z",
  identities: {
    wechat: {
      id: "identity-1",
      externalUserId: "wxid-zhang",
      displayName: "张三微信"
    }
  },
  updatedAt: "2026-06-11T08:00:00.000Z"
};

const administrator: UserListItem = {
  ...builder,
  personId: "person-2",
  accountId: "account-2",
  name: "李管理员",
  phone: "13900139000",
  groupId: "admin",
  groupName: "系统管理员组",
  permissions: ["ticket.claim", "ticket.process", "ticket.accept", "admin.access"],
  hasPassword: true,
  identities: {}
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockUsersFetch() {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/admin/users?")) {
      return new Response(JSON.stringify({
        users: [builder, administrator],
        total: 2,
        page: 1,
        pageSize: 20
      }), { status: 200 });
    }
    if (url === "/api/admin/users/person-1" && init?.method === "PATCH") {
      return new Response(JSON.stringify({
        user: { ...builder, groupLocked: true }
      }), { status: 200 });
    }
    if (url === "/api/admin/users/person-1/disable" && init?.method === "POST") {
      return new Response(JSON.stringify({
        user: { ...builder, enabled: false }
      }), { status: 200 });
    }
    if (url === "/api/admin/users/person-2/password" && init?.method === "POST") {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ message: "unexpected request" }), { status: 500 });
  });
}

describe("AdminUsersPanel", () => {
  it("loads, filters, and edits a user's locked group setting", async () => {
    const fetchMock = mockUsersFetch();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<AdminUsersPanel groups={groups} />);

    expect(await screen.findByText("张三")).not.toBeNull();
    await user.type(screen.getByLabelText("搜索用户"), "13800138000");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("search=13800138000"),
        expect.objectContaining({ cache: "no-store" })
      );
    });

    await user.click(screen.getByRole("button", { name: "编辑张三" }));
    await user.click(screen.getByLabelText("锁定用户分组"));
    await user.click(screen.getByRole("button", { name: "保存用户" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users/person-1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining("\"groupLocked\":true")
        })
      );
    });
  });

  it("confirms disable actions and exposes password reset only to admins", async () => {
    const fetchMock = mockUsersFetch();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));
    const user = userEvent.setup();

    render(<AdminUsersPanel groups={groups} />);

    await screen.findByText("张三");
    await user.click(screen.getByRole("button", { name: "停用张三" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users/person-1/disable",
        expect.objectContaining({ method: "POST" })
      );
    });

    await user.click(screen.getByRole("button", { name: "编辑李管理员" }));
    expect(screen.getByRole("heading", { name: "后台密码" })).not.toBeNull();
    await user.type(screen.getByLabelText("新后台密码"), "StrongPass123!");
    await user.click(screen.getByRole("button", { name: "设置后台密码" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/admin/users/person-2/password",
        expect.objectContaining({ method: "POST" })
      );
    });
  });
});
