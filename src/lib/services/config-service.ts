import { normalizeKeywordGroups } from "../domain/keyword-config";
import { normalizeAiPromptConfig } from "../domain/ai-config";
import type { AppConfig } from "../seed";
import { normalizeAutoAcceptanceConfig, validateAutoAcceptanceConfig } from "./auto-acceptance-service";
import { normalizeWxautoMcpConfig, syncWxautoMcpMessageIntegration } from "../integrations/wxauto/config";

export function stripConfigSecrets(config: AppConfig): AppConfig {
  const wxautoMcp = normalizeWxautoMcpConfig(config.wxautoMcp, config.messageIntegrations);
  return {
    ...config,
    wxautoMcp: {
      ...wxautoMcp,
      accessToken: wxautoMcp.accessToken ? "已设置" : undefined
    },
    autoAcceptance: normalizeAutoAcceptanceConfig(config.autoAcceptance),
    aiModels: config.aiModels.map(({ apiKey, apiKeyConfigured, ...model }) => {
      if (!apiKey && !model.apiKeyEnv) return model;
      return { ...model, apiKeyConfigured: true };
    })
  };
}

export function mergeConfigSecrets(incoming: AppConfig, existing: AppConfig): AppConfig {
  const existingModels = new Map(existing.aiModels.map((model) => [model.id, model]));
  const incomingWxautoMcp = normalizeWxautoMcpConfig(incoming.wxautoMcp, incoming.messageIntegrations);
  const existingWxautoMcp = normalizeWxautoMcpConfig(existing.wxautoMcp, existing.messageIntegrations);
  return {
    ...incoming,
    autoAcceptance: incoming.autoAcceptance ?? existing.autoAcceptance,
    wxautoMcp: {
      ...incomingWxautoMcp,
      accessToken: incomingWxautoMcp.accessToken ?? existingWxautoMcp.accessToken
    },
    aiModels: incoming.aiModels.map(({ apiKeyConfigured, ...model }) => {
      const directApiKey = typeof model.apiKey === "string" ? model.apiKey.trim() : "";
      const existingModel = existingModels.get(model.id);
      return {
        ...model,
        apiKey: directApiKey || existingModel?.apiKey,
        apiKeyEnv: directApiKey ? undefined : model.apiKeyEnv ?? existingModel?.apiKeyEnv
      };
    })
  };
}

export function validateConfig(config: AppConfig) {
  const baseConfig = {
    ...normalizeAiPromptConfig(config),
    keywordGroups: normalizeKeywordGroups(config.keywordGroups),
    autoAcceptance: validateAutoAcceptanceConfig(config.autoAcceptance)
  };
  const wxautoMcp = normalizeWxautoMcpConfig(baseConfig.wxautoMcp, baseConfig.messageIntegrations);
  const normalizedConfig = {
    ...baseConfig,
    wxautoMcp,
    messageIntegrations: syncWxautoMcpMessageIntegration(baseConfig.messageIntegrations, wxautoMcp)
  };
  const enabledIssueTypes = normalizedConfig.issueTypes.filter((item) => item.enabled && item.name !== "自动" && item.id !== "auto");
  if (enabledIssueTypes.length < 1) throw new Error("至少需要配置1个非自动问题类型");
  if (!normalizedConfig.aiModels.some((model) => model.id === "fast" && model.enabled)) throw new Error("快速AI未启用");
  if (!normalizedConfig.aiModels.some((model) => model.id === "smart" && model.enabled)) throw new Error("高智商AI未启用");
  const enabledGroups = normalizedConfig.userGroups?.filter((group) => group.enabled) ?? [];
  if (enabledGroups.length < 1) throw new Error("至少需要配置1个用户分组");
  if (!enabledGroups.some((group) => group.canAccept)) throw new Error("至少需要1个可验收分组");
  return normalizedConfig;
}
