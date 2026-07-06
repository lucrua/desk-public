import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { setShareEdits, setShareComments, revokeShare, deleteShare } from "@/lib/shares";
import { getRevision, listRevisions } from "@/lib/revisions";
import { docIdForSlug } from "@/lib/comments";
import { shareSuggestLimiter, shareCommentLimiter } from "@/lib/rate-limit";
import { MAX_CONTENT_CHARS } from "@/lib/limits";
import { getDocBySlug } from "@/lib/docs";
import { POST } from "./route";
import { POST as commentPost } from "../comments/route";

/**
 * BOUNDARY-CLASS tests for the NEW unauthenticated write ingress:
 * POST /api/s/[token]/suggest (Tier-1 anonymous "suggest an edit").
 *
 * THE ACCESS BOUNDARY IS SACRED — every failure mode is a UNIFORM 404 with the
 * SAME body as a dead token; identity is FORCED server-side (never client input);
 * the path is rate-limited + size-capped. Modeled on the share-comment tests.
 */

const MD_DOC = {
  slug: "suggest-doc",
  title: "Suggest Doc",
  sourcePath: "os/s.md",
  audience: "private",
  format: "md" as const,
  content: "# Hello\n\noriginal body\n",
  by: "lucas",
};
const HTML_DOC = {
  slug: "html-suggest",
  title: "Html Doc",
  sourcePath: "os/h.html",
  audience: "private",
  format: "html" as const,
  content: "<p>hi</p>",
  by: "lucas",
};

const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

function suggestReq(token: string, body: unknown) {
  return new Request(`http://test/api/s/${token}/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function editableShare(slug = "suggest-doc", label = "Microsoft", expiresInDays?: number | null) {
  const share = await createShareOk(slug, label, "lucas", expiresInDays);
  await setShareEdits(share.id, true);
  const token = share.shareUrl.split("/").pop()!;
  return { id: share.id, token, label };
}

describe("POST /api/s/[token]/suggest — public suggest-edit path", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(MD_DOC);
    await publishDocOk(HTML_DOC);
    shareSuggestLimiter.reset();
    shareCommentLimiter.reset();
  });

  it("valid share + edits ON → 201, and the stored revision's identity is the FORCED share label", async () => {
    const { id, token, label } = await editableShare();
    const res = await POST(suggestReq(token, { content: "# Hello\n\nSUGGESTED\n", note: "typo fix" }), ctx(token));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.suggestion.status).toBe("open");
    // No internals leak back.
    expect(json.suggestion.shareId).toBeUndefined();
    expect(json.suggestion.content).toBeUndefined();

    const rev = await getRevision(json.suggestion.id);
    expect(rev).not.toBeNull();
    expect(rev!.content).toBe("# Hello\n\nSUGGESTED\n");
    expect(rev!.note).toBe("typo fix");
    // FORCED provenance — never client-supplied.
    expect(rev!.proposerLabel).toBe(`link:${label}`);
    expect(rev!.authorName).toBe(label);
    expect(rev!.authorKind).toBe(`link:${label}`);
    expect(rev!.shareId).toBe(id);
    // Anchored to the doc's current version.
    const doc = await getDocBySlug("suggest-doc", { includeUnpublished: true });
    expect(rev!.baseVersionId).toBe(doc!.version!.id);
  });

  it("identity CANNOT be overridden by the client body", async () => {
    const { token, label } = await editableShare();
    const res = await POST(
      suggestReq(token, {
        content: "# x",
        proposerLabel: "link:Spoofed",
        authorName: "Spoofed",
        authorKind: "admin",
        shareLabel: "Spoofed",
        shareId: 999,
      }),
      ctx(token),
    );
    expect(res.status).toBe(201);
    const rev = await getRevision((await res.json()).suggestion.id);
    expect(rev!.proposerLabel).toBe(`link:${label}`);
    expect(rev!.authorName).toBe(label);
    expect(rev!.authorKind).toBe(`link:${label}`);
  });

  it("edits OFF → 404 with the SAME body as an unknown token (indistinguishable)", async () => {
    const share = await createShareOk("suggest-doc", "Pedro", "lucas"); // allowEdits defaults OFF
    const token = share.shareUrl.split("/").pop()!;
    const off = await POST(suggestReq(token, { content: "# x" }), ctx(token));
    const unknown = await POST(suggestReq("not-a-real-token", { content: "# x" }), ctx("not-a-real-token"));
    expect(off.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await off.json()).toEqual(await unknown.json());
    // Nothing was queued.
    const docId = (await docIdForSlug("suggest-doc"))!;
    expect(await listRevisions(docId)).toHaveLength(0);
  });

  it("unknown token → uniform 404", async () => {
    const res = await POST(suggestReq("nope", { content: "# x" }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("revoked share → uniform 404", async () => {
    const { id, token } = await editableShare();
    await revokeShare(id);
    expect((await POST(suggestReq(token, { content: "# x" }), ctx(token))).status).toBe(404);
  });

  it("expired share → uniform 404", async () => {
    const { token } = await editableShare("suggest-doc", "Expired", -1); // already past
    expect((await POST(suggestReq(token, { content: "# x" }), ctx(token))).status).toBe(404);
  });

  it("deleted share → uniform 404", async () => {
    const { id, token } = await editableShare();
    await deleteShare(id);
    expect((await POST(suggestReq(token, { content: "# x" }), ctx(token))).status).toBe(404);
  });

  it("html doc → uniform 404 (no editor), even with edits ON", async () => {
    const { token } = await editableShare("html-suggest", "HtmlLink");
    expect((await POST(suggestReq(token, { content: "<p>x</p>" }), ctx(token))).status).toBe(404);
    const docId = (await docIdForSlug("html-suggest"))!;
    expect(await listRevisions(docId)).toHaveLength(0);
  });

  it("rate limit: 5 succeed, 6th in the window → 429", async () => {
    const { token } = await editableShare();
    for (let i = 0; i < 5; i++) {
      const res = await POST(suggestReq(token, { content: `# c${i}` }), ctx(token));
      expect(res.status).toBe(201);
    }
    expect((await POST(suggestReq(token, { content: "# over" }), ctx(token))).status).toBe(429);
  });

  it("rate limit is per-share (another share is unaffected)", async () => {
    const a = await editableShare("suggest-doc", "A");
    const b = await editableShare("suggest-doc", "B");
    for (let i = 0; i < 5; i++) await POST(suggestReq(a.token, { content: `# x${i}` }), ctx(a.token));
    expect((await POST(suggestReq(a.token, { content: "# over" }), ctx(a.token))).status).toBe(429);
    expect((await POST(suggestReq(b.token, { content: "# ok" }), ctx(b.token))).status).toBe(201);
  });

  it("oversize content (post-parse cap) → 400", async () => {
    const { token } = await editableShare();
    const huge = "x".repeat(MAX_CONTENT_CHARS + 1);
    expect((await POST(suggestReq(token, { content: huge }), ctx(token))).status).toBe(400);
    // Nothing queued for an oversize suggestion.
    const docId = (await docIdForSlug("suggest-doc"))!;
    expect(await listRevisions(docId)).toHaveLength(0);
  });

  it("empty / missing content → 400", async () => {
    const { token } = await editableShare();
    expect((await POST(suggestReq(token, { content: "" }), ctx(token))).status).toBe(400);
    expect((await POST(suggestReq(token, {}), ctx(token))).status).toBe(400);
  });

  it("invalid JSON → 400", async () => {
    const { token } = await editableShare();
    const req = new Request(`http://test/api/s/${token}/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect((await POST(req, ctx(token))).status).toBe(400);
  });

  // ── allow_edits and allow_comments are INDEPENDENT ──────────────────────────
  it("edits ON + comments OFF → suggest 201 but comment 404", async () => {
    const { id, token } = await editableShare();
    await setShareComments(id, false);
    expect((await POST(suggestReq(token, { content: "# ok" }), ctx(token))).status).toBe(201);
    const cReq = new Request(`http://test/api/s/${token}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect((await commentPost(cReq, ctx(token))).status).toBe(404);
  });

  it("edits OFF + comments ON → suggest 404 but comment 201", async () => {
    // createShareOk leaves allowComments ON and allowEdits OFF by default.
    const share = await createShareOk("suggest-doc", "CommentsOnly", "lucas");
    const token = share.shareUrl.split("/").pop()!;
    expect((await POST(suggestReq(token, { content: "# x" }), ctx(token))).status).toBe(404);
    const cReq = new Request(`http://test/api/s/${token}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi" }),
    });
    expect((await commentPost(cReq, ctx(token))).status).toBe(201);
  });
});
