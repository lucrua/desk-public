import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { publishDoc } from "@/lib/docs";
import { resolveShare } from "@/lib/shares";
import { GET, POST } from "./route";
import { POST as revokePost } from "./[id]/revoke/route";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeHeaders(role: string | null): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (role !== null) h["x-dev-role"] = role;
  return h;
}

type Role = "admin" | "member" | "anonymous";

function postReq(body: unknown, role: Role = "admin") {
  return new Request("http://test/api/shares", {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
    body: JSON.stringify(body),
  });
}

function getReq(role: Role = "admin") {
  return new Request("http://test/api/shares", {
    method: "GET",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

function revokeReq(id: string, role: Role = "admin") {
  return new Request(`http://test/api/shares/${id}/revoke`, {
    method: "POST",
    headers: makeHeaders(role === "anonymous" ? null : role),
  });
}

const DOC = {
  slug: "my-doc",
  title: "My Doc",
  sourcePath: "os/my-doc.md",
  audience: "external:alice",
  format: "md" as const,
  content: "# Hello",
  by: "admin",
};

// ── POST /api/shares ──────────────────────────────────────────────────────────

describe("POST /api/shares", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDoc(DOC);
  });

  it("admin create returns 200 with id, label, shareUrl containing 43-char token", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(typeof json.id).toBe("number");
    expect(json.label).toBe("Alice");
    expect(typeof json.shareUrl).toBe("string");

    // shareUrl must contain the raw token (43 chars after last /)
    const token = json.shareUrl.split("/").pop();
    expect(token).toHaveLength(43);
  });

  it("member → 403", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Alice" }, "member"));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  // ── directory mode ──────────────────────────────────────────────────────────
  it("directory mode (pathPrefix) → 200 with directory mode + 43-char token", async () => {
    const res = await POST(postReq({ pathPrefix: "os", label: "Folder" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("directory");
    expect(json.shareUrl.split("/").pop()).toHaveLength(43);
  });

  it("directory mode with root prefix ('') → 400", async () => {
    const res = await POST(postReq({ pathPrefix: "", label: "Root" }));
    expect(res.status).toBe(400);
  });

  it("directory mode member → 403", async () => {
    const res = await POST(postReq({ pathPrefix: "os", label: "Folder" }, "member"));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Alice" }, "anonymous"));
    expect(res.status).toBe(403);
  });

  it("unknown doc → 404", async () => {
    const res = await POST(postReq({ docSlug: "no-doc", label: "Alice" }));
    expect(res.status).toBe(404);
  });

  it("missing docSlug → 400", async () => {
    const res = await POST(postReq({ label: "Alice" }));
    expect(res.status).toBe(400);
  });

  it("missing label → 200, auto-named from doc title", async () => {
    const res = await POST(postReq({ docSlug: "my-doc" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    // DOC.title is "My Doc"
    expect(json.label).toBe("My Doc");
  });

  it("docSlug is not a string → 400", async () => {
    const res = await POST(postReq({ docSlug: 123, label: "Alice" }));
    expect(res.status).toBe(400);
  });

  it("label is not a string → treated as no-label, auto-named from doc title", async () => {
    // Non-string label is ignored; service auto-names
    const res = await POST(postReq({ docSlug: "my-doc", label: true }));
    expect(res.status).toBe(200);
  });

  it("expiresInDays: 0 → 200 (0 = never expire)", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Alice", expiresInDays: 0 }));
    expect(res.status).toBe(200);
  });

  it("expiresInDays must be a positive number → 400 for negative", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Alice", expiresInDays: -1 }));
    expect(res.status).toBe(400);
  });

  it("expiresInDays is optional and accepts a positive number → 200", async () => {
    const res = await POST(postReq({ docSlug: "my-doc", label: "Expiring", expiresInDays: 30 }));
    expect(res.status).toBe(200);
  });

  it("invalid JSON body → 400", async () => {
    const req = new Request("http://test/api/shares", {
      method: "POST",
      headers: { "x-dev-role": "admin", "content-type": "application/json" },
      body: "not-json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

// ── GET /api/shares ───────────────────────────────────────────────────────────

describe("GET /api/shares", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDoc(DOC);
  });

  it("admin GET lists shares with viewCount", async () => {
    // Create a share
    const createRes = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    expect(createRes.status).toBe(200);

    const res = await GET(getReq("admin"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(Array.isArray(json.shares)).toBe(true);
    expect(json.shares).toHaveLength(1);
    expect(json.shares[0].viewCount).toBe(0);
  });

  it("member → 403", async () => {
    const res = await GET(getReq("member"));
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await GET(getReq("anonymous"));
    expect(res.status).toBe(403);
  });
});

// ── POST /api/shares/[id]/revoke ──────────────────────────────────────────────

describe("POST /api/shares/[id]/revoke", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDoc(DOC);
  });

  it("admin revoke returns 200 {ok: true}", async () => {
    const createRes = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    const { id } = await createRes.json();

    const res = await revokePost(revokeReq(String(id)), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
  });

  it("revoke of unknown id → 404", async () => {
    const res = await revokePost(revokeReq("99999"), {
      params: Promise.resolve({ id: "99999" }),
    });
    expect(res.status).toBe(404);
  });

  it("second revoke (already revoked) → 404", async () => {
    const createRes = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    const { id } = await createRes.json();

    await revokePost(revokeReq(String(id)), {
      params: Promise.resolve({ id: String(id) }),
    });
    const res = await revokePost(revokeReq(String(id)), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(404);
  });

  it("resolveShare returns null after revoke (capability cut)", async () => {
    const createRes = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    const { id, shareUrl } = await createRes.json();
    const token = shareUrl.split("/").pop()!;

    // Confirm resolves before revoke
    const before = await resolveShare(token);
    expect(before).not.toBeNull();

    await revokePost(revokeReq(String(id)), {
      params: Promise.resolve({ id: String(id) }),
    });

    const after = await resolveShare(token);
    expect(after).toBeNull();
  });

  it("member → 403", async () => {
    const createRes = await POST(postReq({ docSlug: "my-doc", label: "Alice" }));
    const { id } = await createRes.json();

    const res = await revokePost(revokeReq(String(id), "member"), {
      params: Promise.resolve({ id: String(id) }),
    });
    expect(res.status).toBe(403);
  });

  it("anonymous → 403", async () => {
    const res = await revokePost(revokeReq("1", "anonymous"), {
      params: Promise.resolve({ id: "1" }),
    });
    expect(res.status).toBe(403);
  });
});
