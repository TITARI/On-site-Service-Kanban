import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { UserGroup } from "@/lib/domain/types";
import type { UserListItem } from "@/lib/domain/access-control";

const groups: UserGroup[] = [
  {
    id: "admin",
    name: "管理员",
    description: "后台管理员",
    canClaim: true,
    canProcess: true,
    canAccept: true,
    canAdmin: true,
    enabled: true
  },
  {
    id: "builder",
    name: "搭建组",
    description: "现场搭建处理",
    canClaim: true,
    canProcess: true,
    canAccept: false,
    canAdmin: false,
    enabled: true
  }
];

function user(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    personId: "person-1",
    accountId: "account-person-1",
    name: "张三",
    phone: "13800138000",
    groupId: "builder",
    groupName: "搭建组",
    groupLocked: false,
    enabled: true,
    permissions: ["ticket.claim", "ticket.process"],
    hasPassword: false,
    identities: {
      wechat: {
        id: "chat-1",
        externalUserId: "wxid-zhangsan",
        displayName: "张三微信"
      }
    },
    updatedAt: "2026-06-15T08:00:00.000Z",
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminUsersPanel", () => {
  it("filters users and edits a locked group", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/admin/users/person-1") && init?.method === "PATCH") {
        return new Response(JSON.stringify({
          user: user({ groupLocked: true })
        }), { status: 200 });
      }
      if (url.startsWith("/api/admin/users")) {
        return new Response(JSON.stringify({
          users: [user()],
          total: 1,
          page: 1,
          pageSize: 20
        }), { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userDriver = userEvent.setup();

    render(<AdminUsersPanel groups={groups} />);

    expect(await screen.findByText("张三")).not.toBeNull();
    await userDriver.type(screen.getByLabelText("搜索姓名或手机号"), "13800138000");
    await userDriver.click(screen.getByRole("button", { name: "筛选用户" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/users?"),
      expect.objectContaining({ cache: "no-store" })
    ));
    const listCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/admin/users?"))
      .at(-1);
    expect(listCall).toContain("search=13800138000");

    await userDriver.click(screen.getByRole("button", { name: "编辑张三" }));
    const editor = await screen.findByRole("complementary", { name: "编辑用户张三" });
    await userDriver.click(within(editor).getByLabelText("锁定用户分组"));
    await userDriver.click(within(editor).getByRole("button", { name: "保存用户" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/person-1",
      expect.objectContaining({ method: "PATCH" })
    ));
    const patchCall = fetchMock.mock.calls.find((call) => call[0] === "/api/admin/users/person-1");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({
      name: "张三",
      phone: "13800138000",
      groupId: "builder",
      groupLocked: true,
      enabled: true
    });
  });

  it("shows password API errors beside the password action", async () => {
    const passwordError = "至少保留一个可用管理员";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/users/person-1/password" && init?.method === "POST") {
        return new Response(JSON.stringify({ message: passwordError }), { status: 409 });
      }
      if (url.startsWith("/api/admin/users")) {
        return new Response(JSON.stringify({
          users: [user({
            groupId: "admin",
            groupName: "管理员",
            permissions: ["admin.access"],
            hasPassword: true
          })],
          total: 1,
          page: 1,
          pageSize: 20
        }), { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userDriver = userEvent.setup();

    render(<AdminUsersPanel groups={groups} />);

    await userDriver.click(await screen.findByRole("button", { name: "编辑张三" }));
    const editor = await screen.findByRole("complementary", { name: "编辑用户张三" });
    const passwordInput = within(editor).getByLabelText("用户新密码");
    const passwordSection = passwordInput.closest(".admin-user-password");
    const mainEditorForm = editor.querySelector(".admin-user-editor");
    expect(passwordSection).not.toBeNull();
    expect(mainEditorForm).not.toBeNull();

    await userDriver.type(passwordInput, "StrongPassword123!");
    await userDriver.click(within(passwordSection as HTMLElement).getByRole("button", { name: "设置/重置密码" }));

    expect(await within(passwordSection as HTMLElement).findByText(passwordError)).not.toBeNull();
    expect(within(mainEditorForm as HTMLElement).queryByText(passwordError)).toBeNull();
  });
});
