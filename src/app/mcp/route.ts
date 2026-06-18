/**
 * Public `/mcp` alias for the MCP endpoint.
 *
 * The implementation lives at `src/app/api/mcp/route.ts` (alongside the other
 * REST routes). This thin re-export exposes it at the clean public URL
 * `desk.<domain>/mcp` — the path agents configure with
 * `claude mcp add --transport http`. Keeping it as its own route segment
 * (outside the `(hub)` group) means the hub layout/chrome never wraps it.
 *
 * On `share.<domain>` the host-routing middleware 404s everything outside
 * `/s/*`, so this alias is unreachable there (covered by host-routing.test.ts).
 */
export { POST, GET, DELETE } from "@/app/api/mcp/route";
