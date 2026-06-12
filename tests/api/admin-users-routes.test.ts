import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";

const store = vi.hoisted(() => ({
  resolveAccountSession: vi.fn(),
  getConfig: vi.fn(),
  listUsers: vi.fn(),
  getUser: vi.fn(),
  createUser: vi.fn(),
  updateUser: vi.fn(),
  setUserEnabled: vi.fn(),
  deleteUser: vi.fn(),
  setUserPassword: vi.fn(),
  userDeletionHistory: vi.fn(),
  usableAdminCount: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => store as unknown as AppRepository
}));

const collectionRoute = await import("@/app/api/admin/users/route");
const userRoute = await import("@/app/api/admin/users/[userId]/route");
const disableRoute = await import("@/app/api/admin/users/[userId]/disable/route");
const enableRoute = await import("@/app/api/admin/users/[userId]/enable/route");
const passwordRoute = await import("@/app/api/admin/users/[userId]/password/route");

const actor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "Root Admin",
  phone: "13700137000",
  groupId: "admin",
  groupName: "Administrators",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

const user = {
  personId: "person-1",
  accountId: "account-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  groupLocked: false,
  enabled: true,
  permissions: ["ticket.claim", "ticket.process"] as const,
  hasPassword: false,
  identities: {},
  updatedAt: "2026-06-12T00:00:00.000Z"
};

const context = { params: Promise.resolve({ userId: "person-1" }) };

function request(url: string, init?: RequestInit) {
  return new Request(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      cookie: `board_admin_session=${"A".repeat(43)}`,
      ...init?.headers
    }
  });
}

beforeEach(() => {
  Object.values(store).forEach((mock) => mock.mockReset());
  store.resolveAccountSession.mockResolvedValue({
    actor,
    session: {
      id: "session-admin",
      accountId: actor.accountId,
      sessionType: "admin",
      tokenHash: "stored-hash",
      authVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastSeenAt: "2026-06-12T00:00:00.000Z",
      createdAt: "2026-06-12T00:00:00.000Z"
    }
  });
  store.getConfig.mockResolvedValue(defaultConfig());
  store.listUsers.mockResolvedValue({ users: [user], total: 1 });
  store.getUser.mockResolvedValue(user);
  store.createUser.mockResolvedValue(user);
  store.updateUser.mockResolvedValue(user);
  store.setUserEnabled.mockResolvedValue(user);
  store.userDeletionHistory.mockResolvedValue({ deletable: true, reasons: [] });
  store.usableAdminCount.mockResolvedValue(2);
});

describe("admin user routes", () => {
  it("lists filtered users with pagination metadata", async () => {
    const response = await collectionRoute.GET(request(
      "http://localhost/api/admin/users?search=%E5%BC%A0&page=2&pageSize=20&enabled=true"
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      users: [user],
      total: 1,
      page: 2,
      pageSize: 20
    });
    expect(store.listUsers).toHaveBeenCalledWith(expect.objectContaining({
      search: "张",
      enabled: true,
      page: 2,
      pageSize: 20
    }));
  });

  it("creates and updates users through the authenticated actor", async () => {
    const createResponse = await collectionRoute.POST(request(
      "http://localhost/api/admin/users",
      {
        method: "POST",
        body: JSON.stringify({
          name: "张三",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        })
      }
    ));
    expect(createResponse.status).toBe(201);
    expect(store.createUser).toHaveBeenCalledWith(expect.any(Object), actor);

    const patchResponse = await userRoute.PATCH(request(
      "http://localhost/api/admin/users/person-1",
      {
        method: "PATCH",
        body: JSON.stringify({ groupLocked: true })
      }
    ), context);
    expect(patchResponse.status).toBe(200);
    expect(store.updateUser).toHaveBeenCalledWith(
      "person-1",
      { groupLocked: true },
      actor
    );

    const detailResponse = await userRoute.GET(request(
      "http://localhost/api/admin/users/person-1"
    ), context);
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toEqual({ user });
  });

  it("disables, enables, sets a password, and deletes a user", async () => {
    expect((await disableRoute.POST(request(
      "http://localhost/api/admin/users/person-1/disable",
      { method: "POST" }
    ), context)).status).toBe(200);
    expect((await enableRoute.POST(request(
      "http://localhost/api/admin/users/person-1/enable",
      { method: "POST" }
    ), context)).status).toBe(200);
    store.getUser.mockResolvedValue({
      ...user,
      permissions: ["admin.access"],
      hasPassword: true
    });
    expect((await passwordRoute.POST(request(
      "http://localhost/api/admin/users/person-1/password",
      { method: "POST", body: JSON.stringify({ password: "StrongPass123!" }) }
    ), context)).status).toBe(204);
    expect((await userRoute.DELETE(request(
      "http://localhost/api/admin/users/person-1",
      { method: "DELETE" }
    ), context)).status).toBe(204);
  });

  it("maps duplicate phones to conflict and missing users to not found", async () => {
    store.createUser.mockRejectedValueOnce(new Error("手机号已被其他用户使用"));
    const duplicate = await collectionRoute.POST(request(
      "http://localhost/api/admin/users",
      {
        method: "POST",
        body: JSON.stringify({
          name: "张三",
          phone: "13800138000",
          groupId: "builder",
          groupLocked: false,
          enabled: true
        })
      }
    ));
    expect(duplicate.status).toBe(409);

    store.getUser.mockResolvedValueOnce(undefined);
    const missing = await userRoute.PATCH(request(
      "http://localhost/api/admin/users/missing",
      { method: "PATCH", body: JSON.stringify({ name: "Missing" }) }
    ), { params: Promise.resolve({ userId: "missing" }) });
    expect(missing.status).toBe(404);
  });
});
