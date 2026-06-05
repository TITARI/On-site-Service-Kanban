import type { AiPromptDefaults, AiPromptScenario, AiPromptTemplate, AiProviderPresetId } from "./types";

export type AiProviderPreset = {
  id: AiProviderPresetId;
  label: string;
  endpoint?: string;
  modelName?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  helper: string;
};

export type AiPromptConfigLike = {
  aiPromptTemplates?: AiPromptTemplate[];
  aiPromptDefaults?: Partial<AiPromptDefaults>;
};

export const AI_PROVIDER_PRESETS: AiProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    modelName: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    timeoutMs: 8000,
    helper: "适合低成本快速分类和判重，接口兼容 OpenAI Chat Completions。"
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    modelName: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    timeoutMs: 8000,
    helper: "通用兼容选项，适合稳定 JSON 输出。"
  },
  {
    id: "qwen",
    label: "通义千问",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    modelName: "qwen-plus",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    timeoutMs: 10000,
    helper: "阿里云 DashScope 兼容模式，适合国内网络环境。"
  },
  {
    id: "kimi",
    label: "Kimi",
    endpoint: "https://api.moonshot.cn/v1/chat/completions",
    modelName: "moonshot-v1-8k",
    apiKeyEnv: "MOONSHOT_API_KEY",
    timeoutMs: 10000,
    helper: "适合长文本上下文，接口兼容 OpenAI。"
  },
  {
    id: "zhipu",
    label: "智谱 GLM",
    endpoint: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelName: "glm-4-flash",
    apiKeyEnv: "ZHIPU_API_KEY",
    timeoutMs: 10000,
    helper: "智谱开放平台 OpenAI 兼容接口。"
  },
  {
    id: "custom",
    label: "自定义",
    helper: "手动填写 OpenAI 兼容的 chat completions 地址、模型名和 API 密钥。"
  }
];

const BUILT_IN_PROMPTS: AiPromptTemplate[] = [
  {
    id: "builtin-classify-standard",
    scenario: "classify",
    name: "标准分类",
    description: "根据展位号和现场描述判断问题类型，只返回 JSON。",
    systemPrompt: "你是展会现场工单分类助手。只返回JSON：{\"issueType\":\"问题类型\",\"confidence\":0到1}。",
    builtIn: true,
    enabled: true
  },
  {
    id: "builtin-dedupe-standard",
    scenario: "dedupe",
    name: "同展位相似判重",
    description: "判断同展位未关闭工单是否与当前诉求相同，只返回 JSON。",
    systemPrompt: "你是展会现场工单语义判重助手。只返回JSON：{\"confidence\":0到1,\"matchedTicketId\":\"可选工单ID\"}。",
    builtIn: true,
    enabled: true
  },
  {
    id: "builtin-escalation-standard",
    scenario: "escalation",
    name: "超时升级建议",
    description: "根据相似工单、催单次数和描述给出处理建议，只返回 JSON。",
    systemPrompt: "你是展会现场超时工单研判助手。只返回JSON：{\"confidence\":0到1,\"suggestion\":\"处理建议\",\"matchedTicketId\":\"可选工单ID\"}。",
    builtIn: true,
    enabled: true
  },
  {
    id: "builtin-customer-service-standard",
    scenario: "customer-service",
    name: "客服加急研判",
    description: "结合用户消息、历史消息和候选工单判断是否应自动催单或加急，并生成专业客服回复。",
    systemPrompt: "你是展会现场客服研判助手。请只返回JSON：{\"action\":\"reply|ask-follow-up|urge-existing|expedite|manual-review|ignore\",\"confidence\":0到1,\"pressureLevel\":1到5,\"matchedTicketId\":\"可选工单ID\",\"replyText\":\"给用户的专业回复\",\"reason\":\"判断原因\"}。规则：只有明确匹配未关闭工单且客户催办压力较高时才返回expedite；replyText必须专业、安抚、简洁，只能引用输入中的真实工单状态，不得编造进度或承诺具体完成时间。",
    builtIn: true,
    enabled: true
  }
];

export function providerPresetFor(id?: string | null) {
  return AI_PROVIDER_PRESETS.find((preset) => preset.id === id) ?? AI_PROVIDER_PRESETS.find((preset) => preset.id === "custom")!;
}

export function defaultAiPromptTemplates() {
  return BUILT_IN_PROMPTS.map((template) => ({ ...template }));
}

export function defaultAiPromptDefaults(): AiPromptDefaults {
  return {
    classify: "builtin-classify-standard",
    dedupe: "builtin-dedupe-standard",
    escalation: "builtin-escalation-standard",
    "customer-service": "builtin-customer-service-standard"
  };
}

export function aiPromptTemplatesOf(config: AiPromptConfigLike) {
  const incoming = config.aiPromptTemplates ?? [];
  const customTemplates = incoming.filter((template) => !template.builtIn);
  return [...defaultAiPromptTemplates(), ...customTemplates];
}

export function aiPromptDefaultsOf(config: AiPromptConfigLike): AiPromptDefaults {
  return {
    ...defaultAiPromptDefaults(),
    ...(config.aiPromptDefaults ?? {})
  };
}

export function selectedAiPromptTemplate(config: AiPromptConfigLike, scenario: AiPromptScenario) {
  const templates = aiPromptTemplatesOf(config);
  const defaults = aiPromptDefaultsOf(config);
  const configured = templates.find((template) => template.id === defaults[scenario] && template.scenario === scenario && template.enabled);
  return configured ?? templates.find((template) => template.id === defaultAiPromptDefaults()[scenario])!;
}

export function normalizeAiPromptConfig<T extends AiPromptConfigLike>(config: T): T & { aiPromptTemplates: AiPromptTemplate[]; aiPromptDefaults: AiPromptDefaults } {
  const templates = aiPromptTemplatesOf(config).filter((template) => template.name.trim() && template.systemPrompt.trim());
  return {
    ...config,
    aiPromptTemplates: templates,
    aiPromptDefaults: aiPromptDefaultsOf({ ...config, aiPromptTemplates: templates })
  };
}

export function copyAiPromptTemplate(template: AiPromptTemplate, nowIso = new Date().toISOString()): AiPromptTemplate {
  return {
    ...template,
    id: `custom-${template.scenario}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: `${template.name} - 自定义`,
    builtIn: false,
    enabled: true,
    updatedAt: nowIso
  };
}
