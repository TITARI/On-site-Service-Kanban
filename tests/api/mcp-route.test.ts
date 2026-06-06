import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppRepository } from "@/lib/repositories/app-repository";

const repository = vi.hoisted(() => ({
  registerWxautoAgent: vi.fn(),
  submitWxautoEvents: vi.fn(),
  claimWxautoOutbound: vi.fn(),
  completeWxautoOutbound: vi.fn()
}));

vi.mock("@/lib/repositories/app-repository", () => ({
  getAppRepository: (): AppRepository => ({
    kind: "mariadb",
    registerWxautoAgent: repository.registerWxautoAgent,
    submitWxautoEvents: repository.submitWxautoEvents,
    claimWxautoOutbound: repository.claimWxautoOutbound,
    completeWxautoOutbound: repository.completeWxautoOutbound
  } as unknown as AppRepository)
}));

const route = await import("@/app/api/mcp/route");

const bearerToken = "wxauto-route-test-token";
const toolNames = [
  "register_wxauto_agent",
  "submit_wechat_events",
  "claim_outbound_messages",
  "complete_outbound_message"
];

type ToolCallResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};

function initializeRequest(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mcp-route-test", version: "0.1.0" }
      }
    })
  });
}

async function routeFetch(url: string | URL, init?: RequestInit) {
  const request = new Request(url, init);
  if (request.method === "POST") return route.POST(request);
  if (request.method === "GET") return route.GET(request);
  if (request.method === "DELETE") return route.DELETE(request);
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}

async function createClient() {
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
    requestInit: {
      headers: { Authorization: `Bearer ${bearerToken}` }
    },
    fetch: routeFetch
  });
  const client = new Client({ name: "mcp-route-test-client", version: "0.1.0" });
  await client.connect(transport);
  return { client, transport };
}

function asToolCallResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  if ("toolResult" in result) {
    throw new Error("Expected a standard tool call result");
  }
  return result as ToolCallResult;
}

beforeEach(() => {
  process.env.WXAUTO_MCP_TOKEN = bearerToken;
  repository.registerWxautoAgent.mockReset();
  repository.submitWxautoEvents.mockReset();
  repository.claimWxautoOutbound.mockReset();
  repository.completeWxautoOutbound.mockReset();
  repository.registerWxautoAgent.mockResolvedValue({
    deviceId: "device-a",
    serverTime: "2026-06-05T08:00:00.000Z",
    minimumAppVersion: "0.1.0",
    recommendedPollIntervalMs: 2000,
    integrationEnabled: true
  });
  repository.submitWxautoEvents.mockResolvedValue([{ messageId: "wx-1", action: "processed" }]);
  repository.claimWxautoOutbound.mockResolvedValue([{
    messageId: "outbound-1",
    leaseId: "lease-1",
    leaseExpiresAt: "2026-06-05T08:02:00.000Z",
    targetName: "site-team",
    targetConversationId: "conversation-1",
    text: "Ticket created",
    createdAt: "2026-06-05T08:00:00.000Z"
  }]);
  repository.completeWxautoOutbound.mockResolvedValue({ accepted: true });
});

describe("MCP route", () => {
  it("rejects initialize POST requests without bearer authentication", async () => {
    const response = await route.POST(initializeRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Bearer realm="wxauto-mcp"');
    expect(repository.registerWxautoAgent).not.toHaveBeenCalled();
  });

  it("registers an authenticated wxauto agent through a standard MCP tool call", async () => {
    const { client, transport } = await createClient();
    try {
      const result = asToolCallResult(await client.callTool({
        name: "register_wxauto_agent",
        arguments: {
          deviceId: "device-a",
          displayName: "Front Desk PC",
          appVersion: "0.1.0",
          workerVersion: "0.1.0",
          windowsVersion: "Windows 11",
          wechatProcessState: "running",
          wechatLoginState: "logged_in",
          safetyMode: "strict",
          capabilities: ["text"]
        }
      }));

      expect(result.structuredContent).toMatchObject({
        deviceId: "device-a",
        integrationEnabled: true
      });
      expect(JSON.parse(result.content[0].text ?? "")).toMatchObject({
        deviceId: "device-a",
        integrationEnabled: true
      });
      expect(repository.registerWxautoAgent).toHaveBeenCalledWith(expect.objectContaining({
        deviceId: "device-a",
        displayName: "Front Desk PC"
      }));
    } finally {
      await transport.close();
    }
  });

  it("lists exactly the wxauto tools and delegates event, claim, and completion calls", async () => {
    const { client, transport } = await createClient();
    try {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name).sort()).toEqual([...toolNames].sort());

      const submitted = asToolCallResult(await client.callTool({
        name: "submit_wechat_events",
        arguments: {
          deviceId: "device-a",
          events: [{
            messageId: "wx-1",
            sequence: 1,
            conversationId: "conversation-1",
            conversationType: "group",
            senderName: "Alice",
            receivedAt: "2026-06-05T08:00:00.000Z"
          }]
        }
      }));
      expect(submitted.structuredContent).toEqual({
        receipts: [{ messageId: "wx-1", action: "processed" }]
      });
      expect(repository.submitWxautoEvents).toHaveBeenCalledWith({
        deviceId: "device-a",
        events: [{
          messageId: "wx-1",
          sequence: 1,
          conversationId: "conversation-1",
          conversationType: "group",
          senderName: "Alice",
          text: "",
          imageUrls: [],
          receivedAt: "2026-06-05T08:00:00.000Z"
        }]
      });

      const claimed = asToolCallResult(await client.callTool({
        name: "claim_outbound_messages",
        arguments: { deviceId: "device-a", limit: 2 }
      }));
      expect(claimed.structuredContent).toEqual({
        messages: [{
          messageId: "outbound-1",
          leaseId: "lease-1",
          leaseExpiresAt: "2026-06-05T08:02:00.000Z",
          targetName: "site-team",
          targetConversationId: "conversation-1",
          text: "Ticket created",
          createdAt: "2026-06-05T08:00:00.000Z"
        }]
      });
      expect(repository.claimWxautoOutbound).toHaveBeenCalledWith({
        deviceId: "device-a",
        limit: 2,
        supportedMessageTypes: ["text"]
      });

      const completed = asToolCallResult(await client.callTool({
        name: "complete_outbound_message",
        arguments: {
          deviceId: "device-a",
          messageId: "outbound-1",
          leaseId: "lease-1",
          status: "sent",
          attemptedAt: "2026-06-05T08:01:00.000Z"
        }
      }));
      expect(completed.structuredContent).toEqual({ accepted: true });
      expect(repository.completeWxautoOutbound).toHaveBeenCalledWith({
        deviceId: "device-a",
        messageId: "outbound-1",
        leaseId: "lease-1",
        status: "sent",
        attemptedAt: "2026-06-05T08:01:00.000Z"
      });
    } finally {
      await transport.close();
    }
  });
});
