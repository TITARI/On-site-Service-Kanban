import type { MessageIntegrationConfig, WxautoMcpConfig } from "@/lib/domain/types";

export const WXAUTO_MCP_ENDPOINT = "/api/mcp";
export const WXAUTO_MCP_SERVER_NAME = "wxauto-desktop";
export const WXAUTO_MCP_SECRET_ENV = "WXAUTO_MCP_TOKEN";

export function defaultWxautoMcpConfig(): WxautoMcpConfig {
  return {
    enabled: false,
    endpoint: WXAUTO_MCP_ENDPOINT,
    accessToken: undefined,
    autoCreateTickets: false
  };
}

function legacyWechatIntegration(integrations?: MessageIntegrationConfig[]) {
  return integrations?.find((item) => item.channel === "wechat");
}

export function normalizeWxautoMcpConfig(
  input?: Partial<WxautoMcpConfig>,
  integrations?: MessageIntegrationConfig[]
): WxautoMcpConfig {
  const legacy = legacyWechatIntegration(integrations);
  return {
    enabled: input?.enabled ?? legacy?.enabled ?? false,
    endpoint: WXAUTO_MCP_ENDPOINT,
    accessToken: input?.accessToken?.trim() || undefined,
    autoCreateTickets: input?.autoCreateTickets ?? legacy?.autoCreateTickets ?? false
  };
}

export function syncWxautoMcpMessageIntegration(
  integrations: MessageIntegrationConfig[] | undefined,
  wxautoMcp: WxautoMcpConfig
): MessageIntegrationConfig[] {
  const current = integrations?.length ? integrations : [];
  const hasWechat = current.some((item) => item.channel === "wechat");
  const synced = current.map((item) => {
    if (item.channel !== "wechat") return item;
    return {
      ...item,
      label: "wxauto 桌面服务",
      enabled: wxautoMcp.enabled,
      mcpServerName: WXAUTO_MCP_SERVER_NAME,
      endpoint: WXAUTO_MCP_ENDPOINT,
      secretEnv: WXAUTO_MCP_SECRET_ENV,
      autoCreateTickets: wxautoMcp.autoCreateTickets
    };
  });

  if (hasWechat) return synced;

  return [
    ...synced,
    {
      id: "wechat",
      channel: "wechat",
      label: "wxauto 桌面服务",
      enabled: wxautoMcp.enabled,
      mcpServerName: WXAUTO_MCP_SERVER_NAME,
      endpoint: WXAUTO_MCP_ENDPOINT,
      secretEnv: WXAUTO_MCP_SECRET_ENV,
      autoCreateTickets: wxautoMcp.autoCreateTickets
    }
  ];
}
