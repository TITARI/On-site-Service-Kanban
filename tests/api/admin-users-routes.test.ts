import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountSession,
  AuthenticatedActor,
  UserListItem
} from "@/lib/domain/access-control";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { SESSION_COOKIE_NAMES, sessionTokenHash } from "@/lib/services/session-service";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  listUsers: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  deleteUser: vi.fn(),
  setUserPassword: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "file",
    resolveAccountSession: store.resolveAccountSession,
    listUsers: store.listUsers,
    getUser: store.getUser,
    createUser: store.createUser,
    updateUser: store.updateUser,
    setUserEnabled: store.setUserEnabled,
    deleteUser: store.deleteUser,
    setUserPassword: store.setUserPassword
  } as unknown as AppRepository)
}));

function actor(overrides: Partial<AuthenticatedActor> = {}): AuthenticatedActor {
  return {
    accountId: "account-admin",
    personId: "person-admin",
    name: "Root Admin",
    phone: "13700137000",
    groupId: "admin",
    groupName: "Administrators",
    permissions: ["admin.access"],
    sessionType: "admin",
    ...overrides
  };
}

function session(tokenHash: string): AccountSession {
  return {
    id: "session-admin",
    accountId: "account-admin",
    sessionType: "admin",
    tokenHash,
    authVersion: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    lastSeenAt: "2026-06-15T00:00:00.000Z",
    createdAt: "2026-06-15T00:00:00.000Z"
  };
}

function user(overrides: Partial<UserListItem> = {}): UserListItem {
  return {
    personId: "person-1",
    accountId: "account-person-1",
    name: "Alice",
    phone: "13800138000",
    groupId: "builder",
    groupName: "Builder",
    groupLocked: false,
    enabled: true,
    permissions: ["ticket.process"],
    hasPassword: false,
    identities: {},
    updatedAt: "2026-06-15T00:00:00.000Z",
    ...overrides
  };
}

const validBody = {
  name: "Alice",
  phone: "13800138000",
  groupId: "builder",
  groupLocked: false,
  enabled: true
};

const adminToken = Buffer.alloc(32, 7).toString("base64url");

function request(
  url: string,
  method: string,
  body?: unknown,
  cookie = `${SESSION_COOKIE_NAMES.admin}=${adminToken}`
) {
  return new Request(url, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(store)) mock.mockReset();
  store.resolveAccountSession.mockResolvedValue({
    session: session(sessionTokenHash(adminToken)),
    actor: actor()
  });
  store.listUsers.mockResolvedValue({ users: [user()], total: 1 });
  store.getUser.mockResolvedValue(user());
  store.createUser.mockResolvedValue(user());
  store.updateUser.mockResolvedValue(user({ name: "Alice Updated" }));
  store.setUserEnabled.mockImplementation(async (
    _userId: string,
    enabled: boolean
  ) => user({ enabled }));
  store.deleteUser.mockResolvedValue(undefined);
  store.setUserPassword.mockResolvedValue(undefined);
});

describe("admin users routes", () => {
  it("rejects unauthenticated requests before repository user operations", async () => {
    store.resolveAccountSession.mockResolvedValue(undefined);
    const route = await import("@/app/api/admin/users/route");

    const response = await route.GET(new Request("https://board.example/api/admin/users"));

    expect(response.status).toBe(401);
    expect(store.listUsers).not.toHaveBeenCalled();
  });

  it("lists users with pagination metadata", async () => {
    const route = await import("@/app/api/admin/users/route");

    const response = await route.GET(request(
      "https://board.example/api/admin/users?page=2&pageSize=10&enabled=true",
      "GET"
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(store.listUsers).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      enabled: true
    });
    expect(payload).toEqual({
      users: [user()],
      total: 1,
      page: 2,
      pageSize: 10
    });
  });

  it("creates users with 201 and validates bad input as 400", async () => {
    const route = await import("@/app/api/admin/users/route");

    const created = await route.POST(request(
      "https://board.example/api/admin/users",
      "POST",
      validBody
    ));
    const invalid = await route.POST(request(
      "https://board.example/api/admin/users",
      "POST",
      { ...validBody, phone: "12345" }
    ));

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toEqual({ user: user() });
    expect(invalid.status).toBe(400);
  });

  it("maps duplicate phone conflicts to 409", async () => {
    store.createUser.mockRejectedValue(
      new Error("手机号已被其他用户占用")
    );
    const route = await import("@/app/api/admin/users/route");

    const response = await route.POST(request(
      "https://board.example/api/admin/users",
      "POST",
      validBody
    ));

    expect(response.status).toBe(409);
  });

  it("updates, disables, enables, deletes, and changes password with expected status codes", async () => {
    const detailRoute = await import("@/app/api/admin/users/[userId]/route");
    const disableRoute = await import("@/app/api/admin/users/[userId]/disable/route");
    const enableRoute = await import("@/app/api/admin/users/[userId]/enable/route");
    const passwordRoute = await import("@/app/api/admin/users/[userId]/password/route");
    const params = Promise.resolve({ userId: "person-1" });

    const patched = await detailRoute.PATCH(request(
      "https://board.example/api/admin/users/person-1",
      "PATCH",
      { ...validBody, name: "Alice Updated" }
    ), { params });
    const disabled = await disableRoute.POST(request(
      "https://board.example/api/admin/users/person-1/disable",
      "POST",
      {}
    ), { params });
    const enabled = await enableRoute.POST(request(
      "https://board.example/api/admin/users/person-1/enable",
      "POST",
      {}
    ), { params });
    const password = await passwordRoute.POST(request(
      "https://board.example/api/admin/users/person-1/password",
      "POST",
      { password: "StrongPassword123!" }
    ), { params });
    const deleted = await detailRoute.DELETE(request(
      "https://board.example/api/admin/users/person-1",
      "DELETE"
    ), { params });

    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toEqual({
      user: user({ name: "Alice Updated" })
    });
    expect(disabled.status).toBe(200);
    await expect(disabled.json()).resolves.toEqual({
      user: user({ enabled: false })
    });
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toEqual({
      user: user({ enabled: true })
    });
    expect(password.status).toBe(204);
    expect(deleted.status).toBe(204);
  });

  it("maps missing users to 404 and last-admin/delete-history conflicts to 409", async () => {
    const detailRoute = await import("@/app/api/admin/users/[userId]/route");
    const disableRoute = await import("@/app/api/admin/users/[userId]/disable/route");
    const params = Promise.resolve({ userId: "person-1" });

    store.updateUser.mockRejectedValueOnce(new Error("未找到用户"));
    const missing = await detailRoute.PATCH(request(
      "https://board.example/api/admin/users/person-1",
      "PATCH",
      validBody
    ), { params });

    store.setUserEnabled.mockRejectedValueOnce(
      new Error("至少需要保留一个可用管理员账号")
    );
    const lastAdmin = await disableRoute.POST(request(
      "https://board.example/api/admin/users/person-1/disable",
      "POST",
      {}
    ), { params });

    store.deleteUser.mockRejectedValueOnce(
      new Error("用户已有业务历史，不能删除")
    );
    const history = await detailRoute.DELETE(request(
      "https://board.example/api/admin/users/person-1",
      "DELETE"
    ), { params });

    expect(missing.status).toBe(404);
    expect(lastAdmin.status).toBe(409);
    expect(history.status).toBe(409);
  });
});
