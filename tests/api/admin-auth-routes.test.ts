import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { hashPassword } from "@/lib/services/password-service";

const store = vi.hoisted(() => ({
  bootstrapStatus: vi.fn(),
  bootstrapAdmin: vi.fn(),
  adminLoginRecord: vi.fn(),
  recordAdminLoginFailure: vi.fn(),
  recordAdminLoginSuccess: vi.fn(),
  createAccountSession: vi.fn(),
  revokeAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => store as unknown as AppRepository
}));

const bootstrapRoute = await import("@/app/api/admin/auth/bootstrap/route");
const loginRoute = await import("@/app/api/admin/auth/login/route");
const logoutRoute = await import("@/app/api/admin/auth/logout/route");

const actor = {
  accountId: "account-admin",
  personId: "person-admin",
  name: "系统管理员",
  phone: "13800138000",
  groupId: "admin",
  groupName: "系统管理员组",
  permissions: ["admin.access"] as const,
  sessionType: "admin" as const
};

beforeEach(async () => {
  Object.values(store).forEach((mock) => mock.mockReset());
  store.bootstrapStatus.mockResolvedValue({ required: true });
  store.bootstrapAdmin.mockResolvedValue(actor);
  store.adminLoginRecord.mockResolvedValue({
    actor,
    credential: {
      accountId: actor.accountId,
      passwordHash: await hashPassword("StrongPass123!"),
      passwordChangedAt: "2026-06-12T00:00:00.000Z",
      mustChangePassword: false,
      failedAttempts: 0
    }
  });
  store.createAccountSession.mockResolvedValue({});
});

describe("admin auth routes", () => {
  it("bootstraps the first admin with an HttpOnly server session", async () => {
    const response = await bootstrapRoute.POST(new Request(
      "http://localhost/api/admin/auth/bootstrap",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          legacyPassword: "admin123",
          name: "系统管理员",
          phone: "13800138000",
          password: "StrongPass123!",
          group: { mode: "create", name: "系统管理员组" }
        })
      }
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("board_admin_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await expect(response.json()).resolves.toEqual({ user: actor });
  });

  it("logs in with phone and password and uses one generic password error", async () => {
    const response = await loginRoute.POST(new Request(
      "http://localhost/api/admin/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "13800138000", password: "StrongPass123!" })
      }
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("board_admin_session=");

    store.adminLoginRecord.mockResolvedValue(undefined);
    const rejected = await loginRoute.POST(new Request(
      "http://localhost/api/admin/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "13800138000", password: "wrong" })
      }
    ));
    expect(rejected.status).toBe(401);
    await expect(rejected.json()).resolves.toMatchObject({ message: "手机号或密码不正确" });
  });

  it("revokes and expires the admin session on logout", async () => {
    const cookie = `board_admin_session=${"A".repeat(43)}`;
    const response = await logoutRoute.POST(new Request(
      "http://localhost/api/admin/auth/logout",
      { method: "POST", headers: { cookie } }
    ));

    expect(store.revokeAccountSession).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
