import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  expiredSessionCookie,
  requestSessionToken,
  sessionCookie,
  sessionTokenHash
} from "@/lib/services/session-service";

describe("session service", () => {
  it("creates a URL-safe opaque token", () => {
    expect(createSessionToken()).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it("hashes session tokens as SHA-256 hex", () => {
    expect(sessionTokenHash("opaque-token")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates a non-secure mobile session cookie", () => {
    const expiresAt = new Date("2026-07-01T12:34:56.000Z");

    const cookie = sessionCookie("mobile", "mobile-token", expiresAt, false);

    expect(cookie).toContain("board_mobile_session=mobile-token");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Expires=Wed, 01 Jul 2026 12:34:56 GMT");
    expect(cookie).not.toContain("Secure");
  });

  it("creates a secure admin session cookie", () => {
    const cookie = sessionCookie(
      "admin",
      "admin-token",
      new Date("2026-07-01T12:34:56.000Z"),
      true
    );

    expect(cookie).toContain("board_admin_session=admin-token");
    expect(cookie).toContain("Secure");
  });

  it("parses exact cookie names without prefix confusion", () => {
    const request = new Request("https://board.example", {
      headers: {
        Cookie: [
          "xboard_mobile_session=prefix-token",
          "board_mobile_session=mobile%2Dtoken",
          "board_admin_session=admin-token"
        ].join("; ")
      }
    });

    expect(requestSessionToken(request, "mobile")).toBe("mobile-token");
    expect(requestSessionToken(request, "admin")).toBe("admin-token");
  });

  it("does not throw on malformed cookie encoding", () => {
    const request = new Request("https://board.example", {
      headers: { Cookie: "board_mobile_session=%E0%A4%A" }
    });

    expect(() => requestSessionToken(request, "mobile")).not.toThrow();
    expect(requestSessionToken(request, "mobile")).toBe("%E0%A4%A");
  });

  it("returns undefined when the requested cookie is absent", () => {
    const request = new Request("https://board.example", {
      headers: { Cookie: "board_admin_session=admin-token" }
    });

    expect(requestSessionToken(request, "mobile")).toBeUndefined();
  });

  it("expires the requested session cookie", () => {
    const mobileCookie = expiredSessionCookie("mobile");
    const adminCookie = expiredSessionCookie("admin");

    expect(mobileCookie).toContain("board_mobile_session=");
    expect(mobileCookie).toContain("Path=/");
    expect(mobileCookie).toContain("HttpOnly");
    expect(mobileCookie).toContain("SameSite=Lax");
    expect(mobileCookie).toContain("Max-Age=0");
    expect(adminCookie).toContain("board_admin_session=");
    expect(adminCookie).toContain("Max-Age=0");
  });
});
