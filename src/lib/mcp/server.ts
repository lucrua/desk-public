/**
 * Builds a fresh `McpServer` with every tool from the registry bound to a
 * specific principal.
 *
 * Stateless model: the route creates one server + one transport per POST,
 * handles the message, and tears both down. The principal is captured by
 * closure when we register the tools, so each tool handler runs with the
 * caller's identity without threading it through MCP's `authInfo` plumbing.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Principal } from "@/lib/auth";
import { TOOLS } from "./tools";

/** Server identity advertised in the MCP `initialize` response. */
export const MCP_SERVER_INFO = {
  name: "desk",
  version: "0.1.0",
} as const;

/**
 * Construct an MCP server for one request, with all tools bound to `principal`.
 * The authorization decision lives inside each tool handler (mirroring REST),
 * so we register every tool regardless of role — a member calling an admin tool
 * gets a tool *error result*, which is the correct MCP behaviour (tools/list is
 * the same for all staff; authz is enforced at call time).
 */
export function buildMcpServer(principal: Principal): McpServer {
  const server = new McpServer(MCP_SERVER_INFO);

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // The SDK validates args against inputSchema before invoking; we pass the
      // closure-captured principal alongside. The catch keeps unexpected
      // service exceptions (DB errors etc.) from echoing raw internals to the
      // client — anticipated failures already return fail() inside handlers.
      async (args: unknown) => {
        try {
          return await tool.handler(principal, args as never);
        } catch (e) {
          console.error(`[mcp] ${tool.name} failed:`, (e as Error)?.message);
          return {
            content: [{ type: "text" as const, text: "internal error" }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
