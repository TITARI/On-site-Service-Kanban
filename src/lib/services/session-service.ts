import { createHash, randomBytes } from "node:crypto";
import type { SessionType } from "../domain/access-control";

export const SESSION_COOKIE_NAMES = {
  mobile: "board_mobile_session",
  admin: "board_admin_session"
} as const;

export function createSessionToken() {
  return randomBytes(32).toString("base64url");
}

export function sessionTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function requestSessionToken(request: Request, type: SessionType) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const expectedName = SESSION_COOKIE_NAMES[type];
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== expectedName) continue;

    const token = part.slice(separator + 1).trim();
    if (token) return token;
  }

  return undefined;
}

function cookieAttributes(secure: boolean) {
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : undefined
  ].filter((attribute): attribute is string => Boolean(attribute));
}

export function sessionCookie(
  type: SessionType,
  token: string,
  expiresAt: Date,
  secure = process.env.NODE_ENV === "production"
) {
  return [
    `${SESSION_COOKIE_NAMES[type]}=${token}`,
    ...cookieAttributes(secure),
    `Expires=${expiresAt.toUTCString()}`
  ].join("; ");
}

export function expiredSessionCookie(
  type: SessionType,
  secure = process.env.NODE_ENV === "production"
) {
  return [
    `${SESSION_COOKIE_NAMES[type]}=`,
    ...cookieAttributes(secure),
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}
