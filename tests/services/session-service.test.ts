import { describe, expect, it } from "vitest";
import {
  createSessionToken,
  expiredSessionCookie,
  requestSessionToken,
  sessionCookie,
  sessionTokenHash
} from "@/lib/services/session-service";

const TOKEN_A = Buffer.alloc(32, 1).toString("base64url");
const TOKEN_B = Buffer.alloc(32, 2).toString("base64url");

describe("session service", () => {
  it("creates a URL-safe opaque token", () => {
    const token = createSessionToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(Buffer.from(token, "base64url").toString("base64url")).toBe(token);
  });

  it("hashes session tokens as SHA-256 hex", () => {
    expect(sessionTokenHash("opaque-token")).toBe(
      "84d3f23da9b5f51b3269566eff05d3fb23607eeef89567f9cd280b90ca0dbc5c"
    );
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

  it("parses only the exact requested cookie name", () => {
    const request = new Request("https://board.example", {
      headers: {
        Cookie: [
          `xboard_mobile_session=${TOKEN_B}`,
          `board_mobile_session_extra=${TOKEN_B}`,
          `unrelated=${TOKEN_B}`,
          `board_mobile_session=${TOKEN_A}`,
          `board_admin_session=${TOKEN_B}`
        ].join("; ")
      }
    });

    expect(requestSessionToken(request, "mobile")).toBe(TOKEN_A);
    expect(requestSessionToken(request, "admin")).toBe(TOKEN_B);
  });

  it("does not URL-decode percent-encoded token alternatives", () => {
    const percentEncodedToken = `%41${TOKEN_A.slice(1)}`;
    const request = new Request("https://board.example", {
      headers: { Cookie: `board_mobile_session=${percentEncodedToken}` }
    });

    expect(decodeURIComponent(percentEncodedToken)).toBe(TOKEN_A);
    expect(requestSessionToken(request, "mobile")).toBeUndefined();
  });

  it.each([
    ["too short", TOKEN_A.slice(1)],
    ["too long", `${TOKEN_A}A`],
    ["invalid character", `${TOKEN_A.slice(0, -1)}+`],
    ["noncanonical base64url", `${TOKEN_A.slice(0, -1)}B`]
  ])("rejects a %s session token", async (_description, token) => {
    const request = new Request("https://board.example", {
      headers: { Cookie: `board_mobile_session=${token}` }
    });

    expect(requestSessionToken(request, "mobile")).toBeUndefined();
  });

  it("rejects duplicate target cookies", () => {
    const request = new Request("https://board.example", {
      headers: {
        Cookie: [
          `board_mobile_session=${TOKEN_A}`,
          `board_mobile_session=${TOKEN_B}`
        ].join("; ")
      }
    });

    expect(requestSessionToken(request, "mobile")).toBeUndefined();
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
