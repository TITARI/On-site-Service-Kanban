import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig, type AppConfig } from "@/lib/seed";

const repositoryMock = vi.hoisted(() => ({
  getConfig: vi.fn(),
  resolveAccountSession: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: () => ({
    getConfig: repositoryMock.getConfig,
    resolveAccountSession: repositoryMock.resolveAccountSession
  })
}));

import { POST } from "@/app/api/admin/ai-models/route";

function request(body: unknown) {
  return new Request("http://localhost/api/admin/ai-models", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `board_admin_session=${"A".repeat(43)}`
    },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  repositoryMock.resolveAccountSession.mockReset().mockResolvedValue({
    actor: {
      accountId: "account-admin",
      personId: "person-admin",
      name: "Admin",
      phone: "13800138000",
      groupId: "admin",
      groupName: "Administrators",
      permissions: ["admin.access"],
      sessionType: "admin"
    },
    session: {
      id: "session-admin",
      accountId: "account-admin",
      sessionType: "admin",
      tokenHash: "stored-hash",
      authVersion: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      lastSeenAt: "2026-06-12T00:00:00.000Z",
      createdAt: "2026-06-12T00:00:00.000Z"
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  repositoryMock.getConfig.mockReset();
});

describe("admin ai models route", () => {
  it("queries an OpenAI-compatible models endpoint derived from the chat endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "gpt-4o-mini" },
        { id: "gpt-4.1-mini" }
      ]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      endpoint: "https://api.example.com/v1/chat/completions",
      apiKey: "sk-test"
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-test" })
    }));
    await expect(response.json()).resolves.toEqual({ models: ["gpt-4o-mini", "gpt-4.1-mini"] });
  });

  it("requires both endpoint and api key", async () => {
    const response = await POST(request({ endpoint: "https://api.example.com/v1/chat/completions" }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: "请填写接口地址和API密钥" });
  });

  it("uses a saved api key when a configured model id is provided", async () => {
    const savedConfig: AppConfig = defaultConfig();
    savedConfig.aiModels[0] = {
      ...savedConfig.aiModels[0],
      id: "fast",
      provider: "http",
      endpoint: "https://api.example.com/v1/chat/completions",
      apiKey: "saved-key"
    };
    repositoryMock.getConfig.mockResolvedValue(savedConfig);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "deepseek-chat" }]
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      endpoint: "https://api.example.com/v1/chat/completions",
      modelId: "fast"
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer saved-key" })
    }));
    await expect(response.json()).resolves.toEqual({ models: ["deepseek-chat"] });
  });
});
