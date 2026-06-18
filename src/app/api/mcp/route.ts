/**
 * Streamable-HTTP MCP server endpoint.
 *
 * External agents (Claude Code, etc.) connect here over the MCP Streamable HTTP
 * transport. The Cloudflare Access wall + `getPrincipal` already authenticate
 * the request (CF service-token headers → Principal); this route is the
 * protocol layer and binds the resolved principal into the tool handlers, which
 * enforce the SAME authorization rules as the REST API.
 *
 * Stateless model: each POST builds a fresh transport + `McpServer` pair
 * (`sessionIdGenerator: undefined`), handles the single JSON-RPC message, and
 * tears both down. No session persistence — correct for serverless / Next and
 * fine for tool-calling clients. The SDK's `WebStandardStreamableHTTPServerTransport`
 * speaks Web `Request`/`Response` natively, so it drops straight into a Next
 * route handler.
 *
 * Auth failure: an anonymous principal gets a JSON-RPC error with HTTP 401
 * (the standard MCP signal that credentials are missing/invalid). Staff
 * principals proceed; per-tool authz (admin vs staff) happens inside the tools.
 *
 * The public URL is `/mcp` — `src/app/mcp/route.ts` re-exports these handlers so
 * agents point at `desk.<domain>/mcp`. On `share.<domain>` the host-routing
 * middleware 404s everything outside `/s/*`, so `/mcp` is unreachable there.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getPrincipal, isStaff } from "@/lib/auth";
import { buildMcpServer } from "@/lib/mcp/server";

// JSON-RPC error code for an unauthenticated request. -32001 is in the
// implementation-defined server-error range; clients surface the message.
const UNAUTHENTICATED = -32001;

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

/**
 * Resolve + gate the principal, then run one stateless MCP exchange over the
 * given request. Shared by POST and DELETE (GET is rejected — see below).
 */
async function handle(req: Request): Promise<Response> {
  const principal = await getPrincipal(req.headers);

  if (!isStaff(principal)) {
    return jsonRpcError(401, UNAUTHENTICATED, "Unauthorized — staff credentials required");
  }

  const server = buildMcpServer(principal);
  // Stateless: no session id generator → no session persistence between requests.
  // enableJsonResponse → return a single JSON-RPC response (application/json)
  // instead of an SSE stream; correct for request/response tool-calling and
  // simpler for clients (and tests) that don't need server-pushed events.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    const contentLength = Number(req.headers.get("content-length") ?? 0);
    if (contentLength > 4_000_000) {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32600, message: "Request too large" }, id: null }),
        { status: 413, headers: { "content-type": "application/json" } },
      );
    }
    return await transport.handleRequest(req);
  } finally {
    // Tear the per-request pair down so nothing lingers between invocations.
    await transport.close();
    await server.close();
  }
}

export async function POST(req: Request): Promise<Response> {
  return handle(req);
}

export async function DELETE(req: Request): Promise<Response> {
  return handle(req);
}

/**
 * GET would open the server→client SSE stream. In stateless mode there is no
 * standalone stream to attach to, so reject it per the Streamable HTTP spec
 * (405 Method Not Allowed). We still gate auth first so an anonymous probe sees
 * 401, not 405.
 */
export async function GET(req: Request): Promise<Response> {
  const principal = await getPrincipal(req.headers);
  if (!isStaff(principal)) {
    return jsonRpcError(401, UNAUTHENTICATED, "Unauthorized — staff credentials required");
  }
  return jsonRpcError(405, -32000, "Method Not Allowed — stateless server has no SSE stream");
}
