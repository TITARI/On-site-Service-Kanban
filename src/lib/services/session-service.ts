import { createHash, randomBytes } from "node:crypto";
import type { SessionType } from "../domain/access-control";

export const SESSION_COOKIE_NAMES = {
  mobile: "board_mobile_session",
  admin: "board_admin_session"
} as const;

export function createSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function requestSessionToken(
  request: Request,
  type: SessionType
): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const expectedName = SESSION_COOKIE_NAMES[type];
  for (const segment of cookieHeader.split(";")) {
    const separatorIndex = segment.indexOf("=");
    if (separatorIndex < 0) continue;

    const name = segment.slice(0, separatorIndex).trim();
    if (name !== expectedName) continue;

    const value = segment.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  return undefined;
}

export function sessionCookie(
  type: SessionType,
  token: string,
  expiresAt: Date,
  secure = process.env.NODE_ENV === "production"
): string {
  const attributes = [
    `${SESSION_COOKIE_NAMES[type]}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ];
  if (secure) attributes.push("Secure");
  attributes.push(`Expires=${expiresAt.toUTCString()}`);
  return attributes.join("; ");
}

export function expiredSessionCookie(type: SessionType): string {
  return [
    `${SESSION_COOKIE_NAMES[type]}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ].join("; ");
}
