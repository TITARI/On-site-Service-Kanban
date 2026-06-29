import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpAiProvider } from "@/lib/ai/http-provider";
import { createConfiguredAiProvider } from "@/lib/ai/provider";
import { selectedAiPromptTemplate } from "@/lib/domain/ai-config";
import type { AiModelConfig, Ticket } from "@/lib/domain/types";

const sdkMocks = vi.hoisted(() => {
  const languageModel = { modelId: "sdk-model" };
  const modelFactory = vi.fn(() => languageModel);
  return {
    languageModel,
    modelFactory,
    createOpenAICompatible: vi.fn(() => modelFactory),
    generateText: vi.fn(),
    outputJson: vi.fn(() => ({ type: "json" }))
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: sdkMocks.createOpenAICompatible
}));

vi.mock("ai", () => ({
  generateText: sdkMocks.generateText,
  Output: { json: sdkMocks.outputJson }
}));

const httpFastModel: AiModelConfig = {
  id: "fast",
  label: "快速智能模型",
  provider: "http",
  endpoint: "https://ai.example/v1/chat/completions",
  apiKeyEnv: "OPENAI_API_KEY",
  modelName: "gpt-fast",
  timeoutMs: 1000,
  enabled: true
};

const httpSmartModel: AiModelConfig = {
  ...httpFastModel,
  id: "smart",
  label: "高阶智能模型",
  modelName: "gpt-smart"
};

const candidate: Ticket = {
  id: "ticket-1",
  title: "A01 星河科技 网络",
  boothNumber: "A01",
  companyName: "上海星河科技有限公司",
  companyShortName: "星河科技",
  description: "网络断了，扫码失败",
  imageUrls: [],
  issueType: "网络",
  submitterId: "u1",
  submitterName: "张三",
  feedbackUsers: [{ userId: "u1", userName: "张三", feedbackAt: "2026-05-21T08:00:00.000Z" }],
  status: "待受理",
  urgeCount: 0,
  urgeLevel: 0,
  priorityScore: 55,
  aiDecisions: [],
  replies: [],
  timeline: [],
  createdAt: "2026-05-21T08:00:00.000Z",
  updatedAt: "2026-05-21T08:00:00.000Z"
};

beforeEach(() => {
  sdkMocks.modelFactory.mockReturnValue(sdkMocks.languageModel);
  sdkMocks.createOpenAICompatible.mockReturnValue(sdkMocks.modelFactory);
  sdkMocks.outputJson.mockReturnValue({ type: "json" });
});

afterEach(() => {
  vi.resetAllMocks();
  delete process.env.OPENAI_API_KEY;
});

describe("http ai provider", () => {
  it("normalizes a full endpoint and generates a structured classification", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: { issueType: "网络", confidence: 0.93 }
    });

    const decision = await httpAiProvider.classify(
      {
        ...httpFastModel,
        endpoint: "https://ai.example/v1/chat/completions?api-version=2026-06-01"
      },
      "A01",
      "网络断开，扫码失败",
      "只返回分类 JSON"
    );

    expect(sdkMocks.createOpenAICompatible).toHaveBeenCalledWith({
      name: "configured-ai",
      baseURL: "https://ai.example/v1",
      queryParams: { "api-version": "2026-06-01" },
      apiKey: "test-key",
      supportsStructuredOutputs: false
    });
    expect(sdkMocks.modelFactory).toHaveBeenCalledWith("gpt-fast");
    expect(sdkMocks.outputJson).toHaveBeenCalledWith();
    expect(sdkMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: sdkMocks.languageModel,
      system: "只返回分类 JSON",
      prompt: JSON.stringify({ boothNumber: "A01", description: "网络断开，扫码失败" }),
      temperature: 0,
      maxRetries: 2,
      timeout: 1000
    }));
    expect(decision).toMatchObject({
      modelId: "fast",
      provider: "http",
      scenario: "classify",
      action: "classify",
      issueType: "网络",
      confidence: 0.93,
      latencyMs: expect.any(Number)
    });
  });

  it("maps deduplication output and keeps workflow policy local", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: { confidence: 0.92, matchedTicketId: "ticket-1" }
    });

    const decision = await httpAiProvider.dedupe(
      httpSmartModel,
      "A01",
      "网络完全断开，扫码失败",
      [candidate],
      "判断是否重复"
    );

    const request = sdkMocks.generateText.mock.calls[0][0];
    expect(JSON.parse(request.prompt)).toEqual({
      boothNumber: "A01",
      description: "网络完全断开，扫码失败",
      candidates: [{
        id: "ticket-1",
        boothNumber: "A01",
        issueType: "网络",
        description: "网络断了，扫码失败",
        status: "待受理"
      }]
    });
    expect(decision).toMatchObject({
      modelId: "smart",
      provider: "http",
      scenario: "dedupe",
      confidence: 0.92,
      action: "urge",
      matchedTicketId: "ticket-1"
    });
  });

  it("maps escalation output and falls back to the first candidate id", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: {
        confidence: 0.81,
        suggestion: "优先核查责任组",
        matchedTicketId: null
      }
    });

    const decision = await httpAiProvider.escalate(
      httpSmartModel,
      "A01",
      "网络工单已经超时",
      [candidate],
      "给出升级建议"
    );

    expect(decision).toMatchObject({
      modelId: "smart",
      provider: "http",
      scenario: "escalation",
      confidence: 0.81,
      action: "manual-review",
      suggestion: "优先核查责任组",
      matchedTicketId: "ticket-1"
    });
  });

  it("maps customer-service output and limits history to the latest eight messages", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: {
        confidence: 0.9,
        pressureLevel: 4,
        action: "expedite",
        matchedTicketId: "ticket-1",
        replyText: "已为您加急跟进。",
        reason: "客户持续催办"
      }
    });
    const historyMessages = Array.from({ length: 10 }, (_, index) => ({
      text: `message-${index}`,
      createdAt: `2026-05-21T08:00:${String(index).padStart(2, "0")}.000Z`
    }));

    const decision = await httpAiProvider.customerService(
      httpSmartModel,
      {
        messageText: "客户一直在催，请尽快处理",
        senderName: "张三",
        historyMessages,
        candidateTickets: [candidate]
      },
      "根据真实工单状态回复"
    );

    const request = sdkMocks.generateText.mock.calls[0][0];
    const payload = JSON.parse(request.prompt);
    expect(payload.historyMessages).toHaveLength(8);
    expect(payload.historyMessages[0].text).toBe("message-2");
    expect(decision).toMatchObject({
      modelId: "smart",
      provider: "http",
      scenario: "customer-service",
      confidence: 0.9,
      pressureLevel: 4,
      action: "expedite",
      matchedTicketId: "ticket-1",
      replyText: "已为您加急跟进。",
      reason: "客户持续催办"
    });
  });

  it("maps validated exhibitor field suggestions", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: {
        mappings: [{
          field: "boothNumber",
          columnIndex: 0,
          confidence: 0.96,
          reason: "表头为展位号"
        }]
      }
    });
    const context = {
      sheetName: "展商表",
      headers: [{ columnIndex: 0, label: "展位号", samples: ["A01"] }],
      unmappedFields: ["boothNumber" as const]
    };

    const decision = await httpAiProvider.mapExhibitorFields(
      httpSmartModel,
      context,
      "只映射输入中存在的列"
    );

    const request = sdkMocks.generateText.mock.calls[0][0];
    expect(JSON.parse(request.prompt)).toEqual(context);
    expect(decision).toEqual({
      mappings: [{
        field: "boothNumber",
        columnIndex: 0,
        confidence: 0.96,
        reason: "表头为展位号"
      }]
    });
  });

  it("prefers a direct API key over the configured environment variable", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    sdkMocks.generateText.mockResolvedValue({
      output: { issueType: "搭建", confidence: 0.9 }
    });

    await httpAiProvider.classify(
      { ...httpFastModel, apiKey: "direct-key" },
      "A01",
      "展架需要处理"
    );

    expect(sdkMocks.createOpenAICompatible).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: "direct-key"
    }));
  });

  it("uses the default timeout when timeoutMs is zero", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: { issueType: "网络", confidence: 0.9 }
    });

    await httpAiProvider.classify(
      { ...httpFastModel, timeoutMs: 0 },
      "A01",
      "网络断开"
    );

    expect(sdkMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({ timeout: 8000 }));
  });

  it("rejects a missing API key before calling the SDK", async () => {
    await expect(httpAiProvider.classify(httpFastModel, "A01", "网络断开"))
      .rejects.toThrow("AI 模型 fast 未配置密钥");

    expect(sdkMocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("rejects valid JSON that does not satisfy the scenario schema", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: { issueType: "", confidence: 2 }
    });

    await expect(httpAiProvider.classify(httpFastModel, "A01", "网络断开"))
      .rejects.toThrow();
  });

  it("rejects an unsafe endpoint before calling the SDK", async () => {
    await expect(httpAiProvider.classify(
      { ...httpFastModel, endpoint: "http://127.0.0.1/v1/chat/completions", apiKey: "test-key" },
      "A01",
      "网络断开"
    )).rejects.toThrow("AI endpoint invalid:");

    expect(sdkMocks.createOpenAICompatible).not.toHaveBeenCalled();
    expect(sdkMocks.generateText).not.toHaveBeenCalled();
  });

  it("uses the centralized customer-service prompt when none is supplied", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    sdkMocks.generateText.mockResolvedValue({
      output: {
        confidence: 0.7,
        pressureLevel: 2,
        action: "reply",
        matchedTicketId: null,
        replyText: "已收到，我们会继续跟进。",
        reason: "已有关联工单"
      }
    });

    await httpAiProvider.customerService(httpSmartModel, {
      messageText: "现在进度如何",
      historyMessages: [],
      candidateTickets: [candidate]
    });

    expect(sdkMocks.generateText).toHaveBeenCalledWith(expect.objectContaining({
      system: selectedAiPromptTemplate({}, "customer-service").systemPrompt
    }));
  });

  it.each([
    "AI_APICallError: 503 response body",
    "AI_NoObjectGeneratedError: invalid schema output"
  ])("falls back through the configured provider when the SDK rejects: %s", async (message) => {
    process.env.OPENAI_API_KEY = "test-key";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    sdkMocks.generateText.mockRejectedValue(new Error(message));

    const decision = await createConfiguredAiProvider().classify(
      httpFastModel,
      "A01",
      "网络断开，扫码失败"
    );

    expect(decision).toMatchObject({
      modelId: "fast",
      provider: "mock",
      scenario: "classify",
      action: "classify",
      issueType: "网络"
    });
    expect(warn).toHaveBeenCalledWith("[ai] http 降级到 mock", {
      modelId: "fast",
      scenario: "classify",
      endpoint: httpFastModel.endpoint,
      error: message,
      timestamp: expect.any(String)
    });
  });
});
