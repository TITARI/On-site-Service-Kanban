import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";
import { defaultConfig } from "@/lib/seed";

const store = vi.hoisted(() => ({
  getConfig: vi.fn(),
  upsertMobileAccount: vi.fn(),
  createAccountSession: vi.fn(),
  resolveAccountSession: vi.fn(),
  revokeAccountSession: vi.fn(),
  bootstrapStatus: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => store as unknown as AppRepository
}));

const loginRoute = await import("@/app/api/auth/mobile/login/route");
const logoutRoute = await import("@/app/api/auth/mobile/logout/route");
const sessionRoute = await import("@/app/api/auth/session/route");

const actor = {
  accountId: "account-1",
  personId: "person-1",
  name: "张三",
  phone: "13800138000",
  groupId: "builder",
  groupName: "搭建组",
  permissions: ["ticket.claim", "ticket.process"] as const,
  sessionType: "mobile" as const
};

beforeEach(() => {
  Object.values(store).forEach((mock) => mock.mockReset());
  store.getConfig.mockResolvedValue(defaultConfig());
  store.upsertMobileAccount.mockResolvedValue({ actor });
  store.createAccountSession.mockResolvedValue({});
  store.resolveAccountSession.mockResolvedValue(undefined);
  store.bootstrapStatus.mockResolvedValue({ required: false });
});

describe("mobile auth routes", () => {
  it("logs in with an HttpOnly cookie and server-owned actor fields", async () => {
    const response = await loginRoute.POST(new Request("http://localhost/api/auth/mobile/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "张三", phone: "13800138000", groupId: "builder" })
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("board_mobile_session=");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    await expect(response.json()).resolves.toEqual({
      user: expect.objectContaining({ name: "张三", groupId: "builder" })
    });
  });

  it("returns the current session and expires it on logout", async () => {
    store.resolveAccountSession.mockResolvedValue({
      actor,
      session: {
        id: "session-1",
        accountId: "account-1",
        sessionType: "mobile",
        tokenHash: "stored-hash",
        authVersion: 1,
        expiresAt: "2026-06-19T00:00:00.000Z",
        lastSeenAt: "2026-06-12T00:00:00.000Z",
        createdAt: "2026-06-12T00:00:00.000Z"
      }
    });
    const cookie = `board_mobile_session=${"A".repeat(43)}`;
    const session = await sessionRoute.GET(new Request(
      "http://localhost/api/auth/session?type=mobile",
      { headers: { cookie } }
    ));
    await expect(session.json()).resolves.toEqual({ authenticated: true, user: actor });

    const logout = await logoutRoute.POST(new Request(
      "http://localhost/api/auth/mobile/logout",
      { method: "POST", headers: { cookie } }
    ));
    expect(store.revokeAccountSession).toHaveBeenCalledWith(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("reports anonymous session state without throwing", async () => {
    const response = await sessionRoute.GET(new Request(
      "http://localhost/api/auth/session?type=mobile"
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});
