import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AdminUsersPanel } from "@/components/admin-users-panel";
import type { UserGroup } from "@/lib/domain/types";
import type { UserListItem } from "@/lib/domain/access-control";
import { queryKeys } from "@/lib/client/query-keys";
import { renderWithQueryClient } from "../helpers/query-client";

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

const viewerGroup: UserGroup = {
  id: "viewer",
  name: "观察组",
  description: "只保留人员档案",
  canClaim: false,
  canProcess: false,
  canAccept: false,
  canAdmin: false,
  enabled: true
};

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
    version: 0,
    updatedAt: "2026-06-15T08:00:00.000Z",
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminUsersPanel pagination", () => {
  it("loads the next server page through the user table", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({
        users: [user({
          personId: `person-${page}`,
          accountId: `account-person-${page}`,
          name: page === 1 ? "第一页用户" : "第二页用户"
        })],
        total: 21,
        page,
        pageSize: 20
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = userEvent.setup();

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);
    expect(await screen.findByText("第一页用户")).not.toBeNull();
    await driver.click(screen.getByRole("button", { name: "下一页" }));

    expect(await screen.findByText("第二页用户")).not.toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("page=2"))).toBe(true);
  });

  it("returns to the first server page when filters are submitted", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "http://localhost");
      const page = Number(url.searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({
        users: [user({
          personId: `person-${page}`,
          accountId: `account-person-${page}`,
          name: page === 1 ? "第一页用户" : "第二页用户"
        })],
        total: 21,
        page,
        pageSize: 20
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = userEvent.setup();

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);
    expect(await screen.findByText("第一页用户")).not.toBeNull();
    await driver.click(screen.getByRole("button", { name: "下一页" }));
    expect(await screen.findByText("第二页用户")).not.toBeNull();

    await driver.type(screen.getByLabelText("搜索姓名或手机号"), "13800138000");
    fireEvent.submit(screen.getByLabelText("搜索姓名或手机号").closest("form") as HTMLFormElement);

    await waitFor(() => {
      const lastUrl = String(fetchMock.mock.calls.at(-1)?.[0]);
      expect(lastUrl).toContain("page=1");
      expect(lastUrl).toContain("search=13800138000");
    });
  });
});

describe("AdminUsersPanel chat identity controls", () => {
  it("updates the open editor immediately after binding an initially unbound identity", async () => {
    const boundIdentity = {
      id: "identity-wxid-new",
      platform: "wechat",
      externalUserId: "wxid-new",
      displayName: "New WeChat",
      personId: "person-1",
      firstSeenAt: "2026-06-15T00:00:00.000Z",
      lastSeenAt: "2026-06-15T00:00:00.000Z"
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/chat-identities?platform=wechat") {
        return new Response(JSON.stringify({
          identities: [boundIdentity]
        }), { status: 200 });
      }
      if (url === "/api/admin/chat-identities?platform=wecom") {
        return new Response(JSON.stringify({ identities: [] }), { status: 200 });
      }
      if (url === "/api/admin/users/person-1/chat-identities/wechat" && init?.method === "PUT") {
        return new Response(JSON.stringify({
          identity: boundIdentity
        }), { status: 200 });
      }
      if (url.startsWith("/api/admin/users")) {
        return new Response(JSON.stringify({
          users: [user({ identities: {} })],
          total: 1,
          page: 1,
          pageSize: 20
        }), { status: 200 });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const userDriver = userEvent.setup();

    const { queryClient } = renderWithQueryClient(<AdminUsersPanel groups={groups} />);
    queryClient.setQueryData(queryKeys.admin.bootstrap, { config: {} });

    await userDriver.click(await screen.findByRole("button", { name: "编辑张三" }));
    const editor = await screen.findByRole("complementary", { name: "编辑用户张三" });
    const wechatSection = await within(editor).findByRole("region", { name: "微信身份绑定" });
    expect(within(wechatSection).getByText("当前未绑定")).not.toBeNull();
    expect(
      (within(wechatSection).getByRole("button", { name: "解绑微信身份" }) as HTMLButtonElement).disabled
    ).toBe(true);

    await userDriver.selectOptions(
      within(wechatSection).getByLabelText("微信稳定身份"),
      "wxid-new"
    );
    await userDriver.click(within(wechatSection).getByRole("button", { name: "绑定微信身份" }));

    expect(await within(wechatSection).findByText("已绑定 New WeChat（wxid-new）")).not.toBeNull();
    expect(
      (within(wechatSection).getByRole("button", { name: "解绑微信身份" }) as HTMLButtonElement).disabled
    ).toBe(false);
    await waitFor(() => expect(queryClient.getQueryState(queryKeys.admin.bootstrap)?.isInvalidated).toBe(true));
  });

  it("binds chat identities from the editor after explicit conflict confirmation", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/admin/chat-identities?platform=wechat") {
        return new Response(JSON.stringify({
          identities: [{
            id: "identity-wxid-other",
            platform: "wechat",
            externalUserId: "wxid-other",
            displayName: "Other WeChat",
            personId: "person-other",
            firstSeenAt: "2026-06-15T00:00:00.000Z",
            lastSeenAt: "2026-06-15T00:00:00.000Z"
          }]
        }), { status: 200 });
      }
      if (url === "/api/admin/chat-identities?platform=wecom") {
        return new Response(JSON.stringify({ identities: [] }), { status: 200 });
      }
      if (url === "/api/admin/users/person-1/chat-identities/wechat" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        if (!body.confirmationToken) {
          return new Response(JSON.stringify({
            code: "IDENTITY_CONFLICT",
            message: "Identity already belongs to another user",
            confirmationToken: "confirm-token",
            currentOwner: {
              personId: "person-other",
              name: "李四"
            }
          }), { status: 409 });
        }
        return new Response(JSON.stringify({
          identity: {
            id: "identity-wxid-other",
            platform: "wechat",
            externalUserId: "wxid-other",
            displayName: "Other WeChat",
            personId: "person-1",
            firstSeenAt: "2026-06-15T00:00:00.000Z",
            lastSeenAt: "2026-06-15T00:00:00.000Z"
          }
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

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);

    await userDriver.click(await screen.findByRole("button", { name: "编辑张三" }));
    const editor = await screen.findByRole("complementary", { name: "编辑用户张三" });
    await userDriver.selectOptions(
      await within(editor).findByLabelText("微信稳定身份"),
      "wxid-other"
    );
    await userDriver.click(within(editor).getByRole("button", { name: "绑定微信身份" }));

    const dialog = await screen.findByRole("dialog", { name: "确认身份换绑" });
    expect(within(dialog).getByText(/李四/)).not.toBeNull();
    await userDriver.click(within(dialog).getByRole("button", { name: "确认换绑" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/users/person-1/chat-identities/wechat",
      expect.objectContaining({
        method: "PUT",
        body: expect.stringContaining("confirm-token")
      })
    ));
  });
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

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);

    expect(await screen.findByText("张三")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "刷新用户" })).toBeNull();
    await userDriver.type(screen.getByLabelText("搜索姓名或手机号"), "13800138000");
    fireEvent.submit(screen.getByLabelText("搜索姓名或手机号").closest("form") as HTMLFormElement);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/admin/users?"),
      expect.objectContaining({ cache: "no-store" })
    ));
    const listCall = fetchMock.mock.calls
      .map((call) => String(call[0]))
      .filter((url) => url.startsWith("/api/admin/users?"))
      .at(-1);
    expect(listCall).toContain("search=13800138000");
    const listCallsBeforeRefilter = fetchMock.mock.calls
      .filter((call) => String(call[0]).startsWith("/api/admin/users?"))
      .length;

    await userDriver.click(screen.getByRole("button", { name: "筛选用户" }));

    await waitFor(() => expect(fetchMock.mock.calls
      .filter((call) => String(call[0]).startsWith("/api/admin/users?"))
    ).toHaveLength(listCallsBeforeRefilter + 1));

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

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);

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

  it("ignores stale user list responses after a newer filtered response completes", async () => {
    const requests: Array<{
      url: string;
      signal?: AbortSignal | null;
      resolve: (response: Response) => void;
    }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve) => {
      requests.push({ url: String(input), signal: init?.signal, resolve });
    }));
    vi.stubGlobal("fetch", fetchMock);
    const userDriver = userEvent.setup();

    renderWithQueryClient(<AdminUsersPanel groups={groups} />);

    await waitFor(() => expect(requests).toHaveLength(1));
    await userDriver.type(screen.getByLabelText("搜索姓名或手机号"), "13800138000");
    fireEvent.submit(screen.getByLabelText("搜索姓名或手机号").closest("form") as HTMLFormElement);
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].signal?.aborted).toBe(true);

    await act(async () => {
      requests[1].resolve(new Response(JSON.stringify({
        users: [user()],
        total: 1,
        page: 1,
        pageSize: 20
      }), { status: 200 }));
    });
    expect(await screen.findByText("张三")).not.toBeNull();

    await act(async () => {
      requests[0].resolve(new Response(JSON.stringify({
        users: [user({
          personId: "person-old",
          accountId: "account-person-old",
          name: "李四",
          phone: "13900139000"
        })],
        total: 1,
        page: 1,
        pageSize: 20
      }), { status: 200 }));
    });

    expect(screen.getByText("张三")).not.toBeNull();
    expect(screen.queryByText("李四")).toBeNull();
  });

  it("hides password actions when an admin user is moved to a no-permission group", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
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

    renderWithQueryClient(<AdminUsersPanel groups={[...groups, viewerGroup]} />);

    await userDriver.click(await screen.findByRole("button", { name: "编辑张三" }));
    const editor = await screen.findByRole("complementary", { name: "编辑用户张三" });
    expect(within(editor).getByRole("button", { name: "设置/重置密码" })).not.toBeNull();

    await userDriver.selectOptions(within(editor).getByLabelText("用户分组"), "viewer");

    expect(within(editor).queryByRole("button", { name: "设置/重置密码" })).toBeNull();
  });
});
