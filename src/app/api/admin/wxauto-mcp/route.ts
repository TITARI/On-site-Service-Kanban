import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { badRequest, errorMessage, parseJson } from "@/lib/api/errors";
import { getAppRepository } from "@/lib/repositories/app-repository";
import { normalizeWxautoMcpConfig, syncWxautoMcpMessageIntegration, WXAUTO_MCP_ENDPOINT } from "@/lib/integrations/wxauto/config";

function generateAccessToken() {
  return `wxauto_${randomBytes(24).toString("base64url")}`;
}

function tokenPreview(token?: string) {
  if (!token) return undefined;
  if (token.length <= 10) return "已设置";
  return `${token.slice(0, 8)}...${token.slice(-4)}`;
}

async function saveWxautoMcpConfig({
  enabled,
  autoCreateTickets,
  accessToken,
  rotateToken
}: {
  enabled?: boolean;
  autoCreateTickets?: boolean;
  accessToken?: string;
  rotateToken?: boolean;
}) {
  const repository = getAppRepository();
  const config = await repository.getConfig();
  const current = normalizeWxautoMcpConfig(config.wxautoMcp, config.messageIntegrations);
  const nextToken = rotateToken ? generateAccessToken() : accessToken?.trim() || current.accessToken || generateAccessToken();
  const nextWxautoMcp = {
    enabled: enabled ?? current.enabled,
    endpoint: WXAUTO_MCP_ENDPOINT,
    accessToken: nextToken,
    autoCreateTickets: autoCreateTickets ?? current.autoCreateTickets
  };
  const saved = await repository.saveConfig({
    ...config,
    wxautoMcp: nextWxautoMcp,
    messageIntegrations: syncWxautoMcpMessageIntegration(config.messageIntegrations, nextWxautoMcp)
  });
  const normalized = normalizeWxautoMcpConfig(saved.wxautoMcp, saved.messageIntegrations);
  return {
    wxautoMcp: {
      ...normalized,
      accessToken: normalized.accessToken,
      tokenPreview: tokenPreview(normalized.accessToken)
    }
  };
}

export async function GET() {
  const result = await saveWxautoMcpConfig({});
  return NextResponse.json(result);
}

export async function PUT(request: Request) {
  try {
    const body = await parseJson(request) as {
      enabled?: unknown;
      autoCreateTickets?: unknown;
      accessToken?: unknown;
      rotateToken?: unknown;
    };
    const result = await saveWxautoMcpConfig({
      enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      autoCreateTickets: typeof body.autoCreateTickets === "boolean" ? body.autoCreateTickets : undefined,
      accessToken: typeof body.accessToken === "string" ? body.accessToken : undefined,
      rotateToken: body.rotateToken === true
    });
    return NextResponse.json(result);
  } catch (error) {
    return badRequest(errorMessage(error));
  }
}
