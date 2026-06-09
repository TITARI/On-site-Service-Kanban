import { timingSafeEqual } from "node:crypto";

export type WxautoPrincipal = { tokenId: "wxauto-fixed-token" };

function configuredToken(env: NodeJS.ProcessEnv) {
  return env.WXAUTO_MCP_TOKEN?.trim() || env.WECHAT_MCP_SECRET?.trim();
}

function requestToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return request.headers.get("x-mcp-secret")?.trim() ?? request.headers.get("x-wechat-mcp-secret")?.trim();
}

function equalSecret(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticateWxautoRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): WxautoPrincipal | null {
  const expected = configuredToken(env);
  if (!expected) return null;

  const actual = requestToken(request);
  if (!actual) return null;

  return equalSecret(actual, expected) ? { tokenId: "wxauto-fixed-token" } : null;
}
