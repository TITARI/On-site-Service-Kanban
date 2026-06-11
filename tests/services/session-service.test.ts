import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_COOKIE_NAMES,
  createSessionToken,
  expiredSessionCookie,
  requestSessionToken,
  sessionCookie,
  sessionTokenHash
} from "@/lib/services/session-service";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe("session service", () => {
  it("uses separate mobile and admin cookie names", () => {
    expect(SESSION_COOKIE_NAMES).toEqual({
      mobile: "board_mobile_session",
      admin: "board_admin_session"
    });
  });

  it("creates opaque 32-byte base64url tokens", () => {
    const first = createSessionToken();
    const second = createSessionToken();

    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first).not.toBe(second);
  });

  it("hashes session tokens with sha256 hex", () => {
    const token = "opaque-session-token";

    expect(sessionTokenHash(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(sessionTokenHash(token)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("reads the exact requested cookie among whitespace and multiple cookies", () => {
    const request = new Request("https://board.example", {
      headers: {
        cookie: " theme=dark ; board_mobile_session=mobile-token ; board_admin_session=admin-token "
      }
    });

    expect(requestSessionToken(request, "mobile")).toBe("mobile-token");
    expect(requestSessionToken(request, "admin")).toBe("admin-token");
  });

  it("does not match similar cookie names or return blank tokens", () => {
    const similarOnly = new Request("https://board.example", {
      headers: {
        cookie: "board_mobile_session_backup=wrong; xboard_mobile_session=also-wrong"
      }
    });
    const blank = new Request("https://board.example", {
      headers: { cookie: "board_mobile_session=   ; theme=dark" }
    });

    expect(requestSessionToken(similarOnly, "mobile")).toBeUndefined();
    expect(requestSessionToken(blank, "mobile")).toBeUndefined();
    expect(requestSessionToken(new Request("https://board.example"), "admin")).toBeUndefined();
  });

  it("serializes mobile and admin cookies with an explicit secure switch", () => {
    const expiresAt = new Date("2026-06-12T00:00:00Z");
    const secureCookie = sessionCookie("mobile", "mobile-token", expiresAt, true);
    const insecureCookie = sessionCookie("admin", "admin-token", expiresAt, false);

    expect(secureCookie).toBe(
      "board_mobile_session=mobile-token; Path=/; HttpOnly; SameSite=Lax; Secure; Expires=Fri, 12 Jun 2026 00:00:00 GMT"
    );
    expect(insecureCookie).toBe(
      "board_admin_session=admin-token; Path=/; HttpOnly; SameSite=Lax; Expires=Fri, 12 Jun 2026 00:00:00 GMT"
    );
  });

  it("defaults cookie security to the production environment", () => {
    process.env.NODE_ENV = "production";
    const productionCookie = sessionCookie("admin", "token", new Date("2026-06-12T00:00:00Z"));

    process.env.NODE_ENV = "test";
    const testCookie = sessionCookie("admin", "token", new Date("2026-06-12T00:00:00Z"));

    expect(productionCookie).toContain("; Secure;");
    expect(testCookie).not.toContain("; Secure;");
  });

  it("expires both session cookie types with matching security attributes", () => {
    process.env.NODE_ENV = "production";

    for (const type of ["mobile", "admin"] as const) {
      const cookie = expiredSessionCookie(type);

      expect(cookie).toContain(`${SESSION_COOKIE_NAMES[type]}=`);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Max-Age=0");
      expect(cookie).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
    }
  });
});
