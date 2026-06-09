import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { authenticateWxautoRequest } from "@/lib/integrations/wxauto/auth";
import { createWxautoMcpServer } from "@/lib/integrations/wxauto/mcp-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handleMcpRequest(request: Request) {
  const principal = authenticateWxautoRequest(request);
  if (!principal) {
    return Response.json({ message: "Unauthorized" }, {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="wxauto-mcp"' }
    });
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true
  });
  const server = createWxautoMcpServer();
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } finally {
    await transport.close();
    await server.close();
  }
}

export const POST = handleMcpRequest;
export const GET = handleMcpRequest;
export const DELETE = handleMcpRequest;

export function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      Allow: "GET, POST, DELETE, OPTIONS"
    }
  });
}
