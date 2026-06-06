import { describe, expect, it } from "vitest";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";

describe("wxauto bearer authentication", () => {
  it("accepts the configured bearer token", () => {
    const request = new Request("https://board.example/api/mcp", {
      headers: { authorization: "Bearer secret-token" }
    });

    expect(authenticateWxautoRequest(
      request,
      { WXAUTO_MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv
    )).toEqual({ tokenId: "wxauto-fixed-token" });
  });

  it("rejects missing configuration and wrong tokens", () => {
    expect(authenticateWxautoRequest(
      new Request("https://board.example/api/mcp"),
      {} as NodeJS.ProcessEnv
    )).toBeNull();
    expect(authenticateWxautoRequest(
      new Request("https://board.example/api/mcp", {
        headers: { authorization: "Bearer wrong" }
      }),
      { WXAUTO_MCP_TOKEN: "expected" } as NodeJS.ProcessEnv
    )).toBeNull();
  });

  it("rejects missing or non-bearer authorization headers", () => {
    expect(authenticateWxautoRequest(
      new Request("https://board.example/api/mcp"),
      { WXAUTO_MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv
    )).toBeNull();
    expect(authenticateWxautoRequest(
      new Request("https://board.example/api/mcp", {
        headers: { authorization: "Basic secret-token" }
      }),
      { WXAUTO_MCP_TOKEN: "secret-token" } as NodeJS.ProcessEnv
    )).toBeNull();
  });
});
