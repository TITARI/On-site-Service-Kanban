import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfiguredAiProvider } from "@/lib/ai/provider";
import type { AiModelConfig, Ticket } from "@/lib/domain/types";

const httpFastModel: AiModelConfig = {
  id: "fast",
  label: "快速AI",
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
  label: "高智商AI",
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENAI_API_KEY;
});

describe("configured http ai provider", () => {
  it("calls an OpenAI-compatible endpoint and parses classification JSON", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issueType: "网络", confidence: 0.93 }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAiProvider();
    const decision = await provider.classify(httpFastModel, "A01", "网络断开，扫码失败");

    expect(fetchMock).toHaveBeenCalledWith("https://ai.example/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer test-key" })
    }));
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.model).toBe("gpt-fast");
    expect(decision).toMatchObject({ modelId: "fast", action: "classify", issueType: "网络", confidence: 0.93 });
  });

  it("uses a configured system prompt when calling an OpenAI-compatible endpoint", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issueType: "综合服务", confidence: 0.88 }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAiProvider();
    await provider.classify(httpFastModel, "A01", "请帮忙联系展商", "自定义分类提示词，只返回 JSON");

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.messages[0]).toEqual({ role: "system", content: "自定义分类提示词，只返回 JSON" });
  });

  it("uses a direct API key before falling back to an environment variable", async () => {
    process.env.OPENAI_API_KEY = "env-key";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ issueType: "缃戠粶", confidence: 0.9 }) } }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAiProvider();
    await provider.classify({ ...httpFastModel, apiKey: "direct-key" }, "A01", "缃戠粶鏂紑");

    expect(fetchMock).toHaveBeenCalledWith("https://ai.example/v1/chat/completions", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer direct-key" })
    }));
  });

  it("parses smart-ai dedupe responses and falls back to mock when http fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ confidence: 0.92, matchedTicketId: "ticket-1" }) } }]
      }), { status: 200 }))
      .mockRejectedValueOnce(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    const provider = createConfiguredAiProvider();
    const dedupe = await provider.dedupe(httpSmartModel, "A01", "网络完全断开，扫码失败", [candidate]);
    const fallback = await provider.classify(httpFastModel, "A01", "网络断开，扫码失败");

    expect(dedupe).toMatchObject({ modelId: "smart", action: "urge", matchedTicketId: "ticket-1", confidence: 0.92 });
    expect(fallback).toMatchObject({ modelId: "fast", action: "classify", issueType: "网络" });
  });
});
