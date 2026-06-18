/**
 * MCP endpoint tests.
 *
 * Two layers:
 *   1. Route-level (this file drives `POST`/`GET` from ./route directly with
 *      JSON-RPC bodies) — the auth gate, the initialize→tools/list→tools/call
 *      protocol flow, role-scoped tool behaviour, and a full
 *      publish→share→revoke round-trip asserting DB effects.
 *   2. The pure tool registry is additionally unit-tested in
 *      src/lib/mcp/tools.test.ts.
 *
 * The transport runs in JSON-response mode, so each POST yields a single
 * `application/json` JSON-RPC envelope we can parse and assert on.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc, getDocBySlug } from "@/lib/docs";
import { listShares } from "@/lib/shares";
import { POST, GET } from "./route";

// ── helpers ─────────────────────────────────────────────────────────────────

type Role = "admin" | "member" | "anonymous";

function headers(role: Role): Record<string, string> {
  const h: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (role !== "anonymous") h["x-dev-role"] = role;
  return h;
}

function rpc(body: unknown, role: Role = "admin"): Request {
  return new Request("http://test/mcp", {
    method: "POST",
    headers: headers(role),
    body: JSON.stringify(body),
  });
}

/** POST a JSON-RPC message and return the parsed envelope + status. */
async function send(body: unknown, role: Role = "admin") {
  const res = await POST(rpc(body, role));
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  return { status: res.status, json };
}

let nextId = 1;
function initialize(role: Role = "admin") {
  return send(
    {
      jsonrpc: "2.0",
      id: nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    },
    role,
  );
}

function toolsList(role: Role = "admin") {
  return send({ jsonrpc: "2.0", id: nextId++, method: "tools/list", params: {} }, role);
}

function toolsCall(name: string, args: Record<string, unknown>, role: Role = "admin") {
  return send(
    { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } },
    role,
  );
}

/** Parse the JSON payload from a tools/call result's text content block. */
function resultPayload(json: { result?: { content?: Array<{ text?: string }> } }) {
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

const DOC = {
  slug: "test-doc",
  title: "Test Doc",
  sourcePath: "os/test-doc.md",
  audience: "team",
  format: "md" as const,
  content: "# Hello",
  by: "admin",
};

// ── auth gate ───────────────────────────────────────────────────────────────

describe("MCP route — auth gate", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("anonymous → 401 JSON-RPC error", async () => {
    const { status, json } = await initialize("anonymous");
    expect(status).toBe(401);
    expect(json.error).toBeDefined();
    expect(json.error.message).toMatch(/unauthorized/i);
  });

  it("GET → 405 for staff (no SSE stream in stateless mode)", async () => {
    const res = await GET(new Request("http://test/mcp", { method: "GET", headers: headers("admin") }));
    expect(res.status).toBe(405);
  });

  it("GET → 401 for anonymous (auth gated before method check)", async () => {
    const res = await GET(new Request("http://test/mcp", { method: "GET", headers: headers("anonymous") }));
    expect(res.status).toBe(401);
  });
});

// ── protocol flow ───────────────────────────────────────────────────────────

describe("MCP route — protocol flow", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("initialize returns serverInfo desk", async () => {
    const { status, json } = await initialize("admin");
    expect(status).toBe(200);
    expect(json.result.serverInfo.name).toBe("desk");
    expect(json.result.protocolVersion).toBeTruthy();
  });

  it("tools/list returns all 63 tools (admin)", async () => {
    const { json } = await toolsList("admin");
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(
      [
        "add_audience_member",
        "add_comment",
        "add_user_email",
        "approve_access_request",
        "archive_card",
        "assign_card",
        "create_audience",
        "create_bucket",
        "create_card",
        "create_directory_share",
        "create_share",
        "create_user",
        "decide_revision",
        "delete_audience",
        "delete_bucket",
        "delete_catalog_item",
        "delete_comment",
        "delete_doc",
        "delete_share",
        "dismiss_access_request",
        "distribution_overview",
        "get_card",
        "get_catalog_item",
        "get_catalog_schema",
        "get_doc",
        "get_version",
        "list_catalog_items",
        "list_catalog_kinds",
        "list_access_requests",
        "list_audience_members",
        "list_audiences",
        "list_buckets",
        "list_cards",
        "list_comments",
        "list_doc_shares",
        "list_docs",
        "list_events",
        "list_open_revisions",
        "list_revisions",
        "list_share_views",
        "list_shares",
        "list_user_emails",
        "list_users",
        "move_card",
        "propose_revision",
        "publish_doc",
        "remove_audience_member",
        "remove_user_email",
        "resolve_comment",
        "reveal_share",
        "revoke_share",
        "search_docs",
        "set_doc_owner",
        "set_doc_path",
        "set_share_comments",
        "unpublish_doc",
        "update_audience",
        "update_bucket",
        "update_card",
        "update_user",
        "upsert_catalog_item",
        "upsert_catalog_schema",
        "whoami",
      ].sort(),
    );
  });

  it("tools/list returns all 63 tools (member) — same list, authz is at call time", async () => {
    const { json } = await toolsList("member");
    expect(json.result.tools).toHaveLength(63);
  });
});

// ── role-scoped behaviour ────────────────────────────────────────────────────

describe("MCP route — role scoping", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("whoami reflects admin role", async () => {
    const { json } = await toolsCall("whoami", {}, "admin");
    const payload = resultPayload(json);
    expect(payload.kind).toBe("admin");
    expect(payload.name).toBe("Dev Admin");
  });

  it("whoami reflects member role", async () => {
    const { json } = await toolsCall("whoami", {}, "member");
    const payload = resultPayload(json);
    expect(payload.kind).toBe("member");
  });

  it("member calling publish_doc → authz error result (not a crash)", async () => {
    const { status, json } = await toolsCall(
      "publish_doc",
      {
        slug: "x",
        title: "X",
        source_path: "os/x.md",
        audience: "team",
        format: "md",
        content: "# x",
      },
      "member",
    );
    // The HTTP/JSON-RPC layer still succeeds — the failure is inside the result.
    expect(status).toBe(200);
    expect(json.result.isError).toBe(true);
    const payload = resultPayload(json);
    expect(payload.error).toMatch(/admin only/i);
  });

  it("member calling create_share / revoke_share / list_shares → all admin-only errors", async () => {
    for (const [name, args] of [
      ["create_share", { doc_slug: "test-doc", label: "x" }],
      ["revoke_share", { id: 1 }],
      ["list_shares", {}],
    ] as const) {
      const { json } = await toolsCall(name, args as Record<string, unknown>, "member");
      expect(json.result.isError).toBe(true);
      expect(resultPayload(json).error).toMatch(/admin only/i);
    }
  });

  it("member sees member-visible docs but not hidden-audience docs (list_docs scoping)", async () => {
    await publishDoc({ ...DOC, slug: "team-doc", audience: "team" });
    await publishDoc({ ...DOC, slug: "alice-doc", audience: "alice" });

    const { json } = await toolsCall("list_docs", {}, "member");
    const slugs = resultPayload(json).docs.map((d: { slug: string }) => d.slug);
    expect(slugs).toContain("team-doc");
    expect(slugs).not.toContain("alice-doc");
  });

  it("member get_doc on hidden-audience doc → not-found error (no leak)", async () => {
    await publishDoc({ ...DOC, slug: "alice-doc", audience: "alice" });
    const { json } = await toolsCall("get_doc", { slug: "alice-doc" }, "member");
    expect(json.result.isError).toBe(true);
    expect(resultPayload(json).error).toMatch(/not found/i);
  });

  it("list_audiences works for staff member", async () => {
    const { json } = await toolsCall("list_audiences", {}, "member");
    expect(json.result.isError).toBeFalsy();
    const keys = resultPayload(json).audiences.map((a: { key: string }) => a.key);
    expect(keys).toContain("team");
  });
});

// ── full publish → share → revoke flow with DB assertions ────────────────────

describe("MCP route — publish→share→revoke flow (admin, DB effects)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("publishes a doc, shares it, lists, and revokes — asserting DB state at each step", async () => {
    // publish
    const pub = await toolsCall("publish_doc", {
      slug: "flow-doc",
      title: "Flow Doc",
      source_path: "os/flow-doc.md",
      audience: "team",
      format: "md",
      content: "# flow",
    });
    expect(pub.json.result.isError).toBeFalsy();
    const pubPayload = resultPayload(pub.json);
    expect(pubPayload.isNewVersion).toBe(true);
    expect(pubPayload.hubUrl).toMatch(/\/docs\/flow-doc$/);

    // DB: doc exists + published
    const doc = await getDocBySlug("flow-doc", { scope: { viewer: "admin" } });
    expect(doc).not.toBeNull();
    expect(doc!.version!.content).toBe("# flow");

    // share
    const share = await toolsCall("create_share", { doc_slug: "flow-doc", label: "Alice" });
    const sharePayload = resultPayload(share.json);
    expect(sharePayload.shareUrl).toMatch(/\/s\/[A-Za-z0-9_-]{43}$/);
    const shareId = sharePayload.id;

    // DB: share row exists
    const sharesAfterCreate = await listShares();
    expect(sharesAfterCreate.some((s) => s.id === shareId && s.revokedAt === null)).toBe(true);

    // list_shares via tool
    const list = await toolsCall("list_shares", {});
    const listed = resultPayload(list.json).shares;
    expect(listed.some((s: { id: number }) => s.id === shareId)).toBe(true);

    // revoke
    const revoke = await toolsCall("revoke_share", { id: shareId });
    expect(resultPayload(revoke.json).ok).toBe(true);

    // DB: share revoked
    const sharesAfterRevoke = await listShares();
    expect(sharesAfterRevoke.find((s) => s.id === shareId)!.revokedAt).not.toBeNull();

    // double revoke → error result
    const revoke2 = await toolsCall("revoke_share", { id: shareId });
    expect(revoke2.json.result.isError).toBe(true);
  });

  it("publish_doc with unknown audience → error result", async () => {
    const { json } = await toolsCall("publish_doc", {
      slug: "bad-aud",
      title: "Bad",
      source_path: "os/bad.md",
      audience: "nonexistent",
      format: "md",
      content: "# x",
    });
    expect(json.result.isError).toBe(true);
    expect(resultPayload(json).error).toMatch(/unknown audience/i);
  });

  it("publish_doc with invalid slug → error result", async () => {
    const { json } = await toolsCall("publish_doc", {
      slug: "Bad Slug",
      title: "Bad",
      source_path: "os/bad.md",
      audience: "team",
      format: "md",
      content: "# x",
    });
    expect(json.result.isError).toBe(true);
    expect(resultPayload(json).error).toMatch(/slug/i);
  });

  it("create_share for unknown doc → not-found error result", async () => {
    const { json } = await toolsCall("create_share", { doc_slug: "ghost", label: "x" });
    expect(json.result.isError).toBe(true);
    expect(resultPayload(json).error).toMatch(/not found/i);
  });
});
