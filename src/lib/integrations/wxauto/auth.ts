import { timingSafeEqual } from "node:crypto";

export type WxautoPrincipal = { tokenId: string };

function equalSecret(actual: string, expected: string) {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticateWxautoRequest(
  request: Request,
  env: NodeJS.ProcessEnv = process.env
): WxautoPrincipal | null {
  const expected = env.WXAUTO_MCP_TOKEN;
  if (!expected) return null;

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;

  const actual = authorization.slice("Bearer ".length).trim();
  return equalSecret(actual, expected) ? { tokenId: "wxauto-fixed-token" } : null;
}
