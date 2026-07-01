import { describe, expect, it } from "vitest";
import { mergeConfigSecrets, stripConfigSecrets, validateConfig } from "@/lib/services/config-service";
import { defaultConfig } from "@/lib/seed";

describe("config service", () => {
  it("defaults processing group conversations to an empty list", () => {
    const config = defaultConfig();

    expect(config.processingGroupConversations).toEqual([]);
    expect(validateConfig(config).processingGroupConversations).toEqual([]);
  });

  it("normalizes legacy config without processing group conversations", () => {
    const config = defaultConfig();
    delete config.processingGroupConversations;

    expect(validateConfig(config).processingGroupConversations).toEqual([]);
  });

  it("preserves processing group conversations when a legacy client omits them", () => {
    const existing = defaultConfig();
    existing.processingGroupConversations = [
      { groupId: "搭建组", wechatConversationId: "wechat-group-builder" }
    ];
    const incoming = { ...existing };
    delete incoming.processingGroupConversations;

    expect(mergeConfigSecrets(incoming, existing).processingGroupConversations).toEqual(
      existing.processingGroupConversations
    );
  });

  it("normalizes the default auto acceptance settings", () => {
    const config = defaultConfig();

    expect(validateConfig(config).autoAcceptance).toEqual({ enabled: true, timeoutMinutes: 30 });
  });

  it("accepts valid auto acceptance settings including disabling the feature", () => {
    const config = defaultConfig();

    expect(validateConfig({ ...config, autoAcceptance: { enabled: false, timeoutMinutes: 60 } }).autoAcceptance).toEqual({
      enabled: false,
      timeoutMinutes: 60
    });
  });

  it("rejects auto acceptance timeout minutes outside the supported range", () => {
    const config = defaultConfig();

    expect(() => validateConfig({ ...config, autoAcceptance: { enabled: true, timeoutMinutes: 0 } })).toThrow("自动验收时效需为 1 至 10080 分钟的整数");
    expect(() => validateConfig({ ...config, autoAcceptance: { enabled: true, timeoutMinutes: 10081 } })).toThrow("自动验收时效需为 1 至 10080 分钟的整数");
    expect(() => validateConfig({ ...config, autoAcceptance: { enabled: true, timeoutMinutes: 1.5 } })).toThrow("自动验收时效需为 1 至 10080 分钟的整数");
  });

  it("requires at least one enabled non-auto issue type", () => {
    const config = defaultConfig();
    config.issueTypes = [{ id: "auto", name: "自动", urgencyMinutes: 0, priorityWeight: 0, enabled: true }];

    expect(() => validateConfig(config)).toThrow("至少需要配置1个非自动问题类型");
  });

  it("normalizes legacy user groups without admin permission to canAdmin false", () => {
    const config = defaultConfig();
    config.userGroups = [
      {
        id: "legacy",
        name: "Legacy Group",
        description: "Imported before admin permissions existed",
        canClaim: true,
        canProcess: true,
        canAccept: true,
        enabled: true
      } as NonNullable<typeof config.userGroups>[number]
    ];

    expect(validateConfig(config).userGroups?.[0]).toEqual(expect.objectContaining({
      id: "legacy",
      canAdmin: false
    }));
  });

  it("keeps direct ai api keys for server-side config and strips them from client responses", () => {
    const config = defaultConfig();
    config.aiModels[0] = { ...config.aiModels[0], provider: "http", endpoint: "https://ai.example/v1/chat/completions", apiKey: "secret-key", apiKeyEnv: "OPENAI_API_KEY" };

    const validated = validateConfig(config);

    expect(validated.aiModels[0].apiKey).toBe("secret-key");
    expect(validated.aiModels[0].apiKeyEnv).toBe("OPENAI_API_KEY");
    const clientModel = stripConfigSecrets(validated).aiModels[0];
    expect(clientModel.apiKey).toBeUndefined();
    expect(clientModel.apiKeyConfigured).toBe(true);
  });

  it("preserves existing direct ai api keys when incoming client config omits them", () => {
    const existing = defaultConfig();
    existing.aiModels[0] = { ...existing.aiModels[0], provider: "http", apiKey: "existing-secret" };
    const incoming = stripConfigSecrets(existing);
    incoming.aiModels[0] = { ...incoming.aiModels[0], endpoint: "https://ai.example/v1/chat/completions", apiKeyConfigured: true };

    const merged = mergeConfigSecrets(incoming, existing);

    expect(merged.aiModels[0].apiKey).toBe("existing-secret");
    expect(merged.aiModels[0].apiKeyConfigured).toBeUndefined();
  });
});
