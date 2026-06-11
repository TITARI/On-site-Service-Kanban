import { createHash, randomBytes } from "node:crypto";
import type { SessionType } from "../domain/access-control";

const SESSION_TOKEN_BYTES = 32;
const SESSION_TOKEN_LENGTH = 43;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

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

function isSessionToken(token: string) {
  if (token.length !== SESSION_TOKEN_LENGTH || !BASE64URL_PATTERN.test(token)) return false;

  const decoded = Buffer.from(token, "base64url");
  return decoded.length === SESSION_TOKEN_BYTES && decoded.toString("base64url") === token;
}

export function requestSessionToken(request: Request, type: SessionType) {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const expectedName = SESSION_COOKIE_NAMES[type];
  let matched = false;
  let matchedToken: string | undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== expectedName) continue;

    if (matched) return undefined;
    matched = true;

    const token = part.slice(separator + 1).trim();
    if (isSessionToken(token)) matchedToken = token;
  }

  return matchedToken;
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
  if (!isSessionToken(token)) throw new Error("会话令牌格式无效");

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
