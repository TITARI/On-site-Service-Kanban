import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/lib/seed";
import { SESSION_COOKIE_NAMES } from "@/lib/services/session-service";

const ADMIN_TOKEN = Buffer.alloc(32, 4).toString("base64url");

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
      Cookie: `${SESSION_COOKIE_NAMES.admin}=${ADMIN_TOKEN}`
    },
    body: JSON.stringify(body)
  });
}

function stubModelsFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    data: [{ id: "deepseek-chat" }]
  }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  repositoryMock.getConfig.mockReset();
  repositoryMock.resolveAccountSession.mockReset();
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

describe("admin ai models security", () => {
  beforeEach(() => {
    repositoryMock.getConfig.mockResolvedValue(defaultConfig());
    repositoryMock.resolveAccountSession.mockResolvedValue({
      actor: {
        accountId: "account-admin",
        personId: "person-admin",
        name: "Admin",
        phone: "13800138000",
        groupId: "group-admin",
        groupName: "Admins",
        permissions: ["admin.access"],
        sessionType: "admin"
      },
      session: {
        id: "session-admin",
        accountId: "account-admin",
        sessionType: "admin",
        tokenHash: "hash",
        authVersion: 1,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        lastSeenAt: new Date().toISOString(),
        createdAt: new Date().toISOString()
      }
    });
  });

  it.each([
    "http://127.0.0.1:3000/",
    "http://169.254.169.254/",
    "http://10.0.0.1/"
  ])("rejects SSRF-prone endpoint %s", async (endpoint) => {
    const fetchMock = stubModelsFetch();

    const response = await POST(request({ endpoint, apiKey: "sk-test" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a public HTTPS model endpoint", async () => {
    const fetchMock = stubModelsFetch();

    const response = await POST(request({
      endpoint: "https://api.deepseek.com/v1/models",
      apiKey: "sk-test"
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-test" })
    }));
    await expect(response.json()).resolves.toEqual({ models: ["deepseek-chat"] });
  });

  it("rejects apiKeyEnv names outside the AI whitelist", async () => {
    process.env.DATABASE_URL = "mysql://secret";
    const fetchMock = stubModelsFetch();

    const response = await POST(request({
      endpoint: "https://api.deepseek.com/v1/models",
      modelId: "fast",
      apiKeyEnv: "DATABASE_URL"
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ message: expect.stringContaining("apiKeyEnv") });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows whitelisted apiKeyEnv names", async () => {
    process.env.OPENAI_API_KEY = "allowed-key";
    const fetchMock = stubModelsFetch();

    const response = await POST(request({
      endpoint: "https://api.deepseek.com/v1/models",
      modelId: "fast",
      apiKeyEnv: "OPENAI_API_KEY"
    }));

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer allowed-key" })
    }));
  });

  it("returns 504 when the model endpoint times out", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const timeoutError = new Error("model endpoint timed out");
    timeoutError.name = "TimeoutError";
    const fetchMock = vi.fn(async () => {
      throw timeoutError;
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request({
      endpoint: "https://api.deepseek.com/v1/models",
      apiKey: "sk-test"
    }));

    expect(response.status).toBe(504);
    expect(timeoutSpy).toHaveBeenCalledWith(8_000);
    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/v1/models", expect.objectContaining({
      signal: controller.signal
    }));
  });
});
