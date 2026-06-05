import { describe, expect, it } from "vitest";
import {
  aiPromptDefaultsOf,
  aiPromptTemplatesOf,
  copyAiPromptTemplate,
  defaultAiPromptTemplates,
  providerPresetFor,
  selectedAiPromptTemplate
} from "@/lib/domain/ai-config";
import type { AiPromptTemplate } from "@/lib/domain/types";

describe("ai config helpers", () => {
  it("returns common provider recommendations", () => {
    expect(providerPresetFor("deepseek")).toMatchObject({
      id: "deepseek",
      label: "DeepSeek",
      endpoint: "https://api.deepseek.com/v1/chat/completions",
      modelName: "deepseek-chat",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      timeoutMs: 8000
    });
    expect(providerPresetFor("openai")).toMatchObject({
      id: "openai",
      modelName: "gpt-4o-mini",
      apiKeyEnv: "OPENAI_API_KEY"
    });
  });

  it("normalizes missing prompt templates to built-in defaults", () => {
    const templates = aiPromptTemplatesOf({});
    const defaults = aiPromptDefaultsOf({});

    expect(templates).toHaveLength(4);
    expect(templates.map((template) => template.scenario)).toEqual(["classify", "dedupe", "escalation", "customer-service"]);
    expect(defaults.classify).toBe("builtin-classify-standard");
    expect(defaults.dedupe).toBe("builtin-dedupe-standard");
    expect(defaults.escalation).toBe("builtin-escalation-standard");
    expect(defaults["customer-service"]).toBe("builtin-customer-service-standard");
  });

  it("selects a configured custom default template for a scenario", () => {
    const custom: AiPromptTemplate = {
      id: "custom-classify",
      scenario: "classify",
      name: "自定义分类",
      description: "偏保守分类",
      systemPrompt: "只按已配置类型返回JSON",
      builtIn: false,
      enabled: true,
      updatedAt: "2026-06-04T08:00:00.000Z"
    };

    expect(selectedAiPromptTemplate({
      aiPromptTemplates: [...defaultAiPromptTemplates(), custom],
      aiPromptDefaults: { classify: custom.id }
    }, "classify")).toEqual(custom);
  });

  it("copies a built-in prompt template into an editable custom template", () => {
    const builtIn = defaultAiPromptTemplates()[0];
    const copied = copyAiPromptTemplate(builtIn, "2026-06-04T08:00:00.000Z");

    expect(copied).toMatchObject({
      scenario: builtIn.scenario,
      name: `${builtIn.name} - 自定义`,
      description: builtIn.description,
      systemPrompt: builtIn.systemPrompt,
      builtIn: false,
      enabled: true,
      updatedAt: "2026-06-04T08:00:00.000Z"
    });
    expect(copied.id).not.toBe(builtIn.id);
  });
});
