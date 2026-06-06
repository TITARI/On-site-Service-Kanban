import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";
import { createWxautoMcpServer } from "@/lib/integrations/wxauto/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized() {
  return new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": 'Bearer realm="wxauto-mcp"'
    }
  });
}

function methodNotAllowed() {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: { Allow: "POST" }
  });
}

export async function POST(request: Request) {
  if (!authenticateWxautoRequest(request)) {
    return unauthorized();
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createWxautoMcpServer();

  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch {
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: "Internal server error"
      },
      id: null
    }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  } finally {
    await server.close().catch(() => undefined);
  }
}

export function GET() {
  return methodNotAllowed();
}

export function DELETE() {
  return methodNotAllowed();
}
