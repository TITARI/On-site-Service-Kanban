import { describe, expect, it } from "vitest";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";

describe("wxauto MCP authentication", () => {
  it("accepts the configured bearer token", () => {
    const request = new Request("https://board.example/api/mcp", {
      headers: { authorization: "Bearer secret-token" }
    });

    expect(authenticateWxautoRequest(request, { env: { WXAUTO_MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv }))
      .toEqual({ tokenId: "wxauto-fixed-token" });
  });

  it("falls back to the legacy WeChat bridge secret during migration", () => {
    const request = new Request("https://board.example/api/mcp", {
      headers: { "x-mcp-secret": "bridge-secret" }
    });

    expect(authenticateWxautoRequest(request, { env: { WECHAT_MCP_SECRET: "bridge-secret" } as NodeJS.ProcessEnv }))
      .toEqual({ tokenId: "wxauto-fixed-token" });
  });

  it("rejects missing configuration and wrong tokens", () => {
    expect(authenticateWxautoRequest(new Request("https://board.example/api/mcp"), { env: {} as NodeJS.ProcessEnv })).toBeNull();
    expect(authenticateWxautoRequest(new Request("https://board.example/api/mcp", {
      headers: { authorization: "Bearer wrong" }
    }), { env: { WXAUTO_MCP_TOKEN: "expected" } as NodeJS.ProcessEnv })).toBeNull();
  });
});
