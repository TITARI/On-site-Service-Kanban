import { timingSafeEqual } from "node:crypto";

export type WxautoPrincipal = { tokenId: "wxauto-fixed-token" };

type AuthOptions = {
  configuredToken?: string;
  env?: NodeJS.ProcessEnv;
};

function configuredToken({ configuredToken: token, env = process.env }: AuthOptions = {}) {
  return token?.trim() || env.WXAUTO_MCP_TOKEN?.trim() || env.WECHAT_MCP_SECRET?.trim();
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

function isAuthOptions(value: AuthOptions | NodeJS.ProcessEnv): value is AuthOptions {
  return "env" in value || "configuredToken" in value;
}

export function authenticateWxautoRequest(
  request: Request,
  options: AuthOptions | NodeJS.ProcessEnv = {}
): WxautoPrincipal | null {
  const authOptions: AuthOptions = isAuthOptions(options) ? options : { env: options };
  const expected = configuredToken(authOptions);
  if (!expected) return null;

  const actual = requestToken(request);
  if (!actual) return null;

  return equalSecret(actual, expected) ? { tokenId: "wxauto-fixed-token" } : null;
}
