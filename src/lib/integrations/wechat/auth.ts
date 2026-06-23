import { timingSafeEqual } from "node:crypto";

function requestSecret(request: Request) {
  const authorization = request.headers.get("authorization");
  return request.headers.get("x-integration-secret")
    ?? request.headers.get("x-mcp-secret")
    ?? request.headers.get("x-wechat-mcp-secret")
    ?? (authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : undefined);
}

export function isWechatRequestAuthorized(request: Request, secretEnv?: string): boolean {
  if (!secretEnv) return false;
  const expected = process.env[secretEnv];
  if (!expected) return false;

  const actual = requestSecret(request) ?? "";
  if (!actual) return false;

  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}
