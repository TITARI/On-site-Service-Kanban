import { describe, expect, it } from "vitest";
import { mergeConfigSecrets, stripConfigSecrets, validateConfig } from "@/lib/services/config-service";
import { defaultConfig } from "@/lib/seed";

describe("config service", () => {
  it("requires at least one enabled non-auto issue type", () => {
    const config = defaultConfig();
    config.issueTypes = [{ id: "auto", name: "自动", urgencyMinutes: 0, priorityWeight: 0, enabled: true }];

    expect(() => validateConfig(config)).toThrow("至少需要配置1个非自动问题类型");
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
