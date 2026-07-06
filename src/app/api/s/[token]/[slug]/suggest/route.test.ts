import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, publishDocOk, seedUser, seedSpace } from "@/test/db";
import { createDirectoryShare, setShareEdits, setShareComments, revokeShare } from "@/lib/shares";
import { getRevision, listRevisions } from "@/lib/revisions";
import { docIdForSlug } from "@/lib/comments";
import { shareSuggestLimiter } from "@/lib/rate-limit";
import { POST } from "./route";

/**
 * BOUNDARY-CLASS tests for POST /api/s/[token]/[slug]/suggest — a suggestion on
 * a doc opened UNDER a DIRECTORY share. resolveShareDoc is THE guard (published
 * + under the prefix + in the share's space); every failure → uniform 404.
 * Identity is FORCED to "link:<folder label>". Modeled on the dir-comment test.
 */

const ctx = (token: string, slug: string) => ({ params: Promise.resolve({ token, slug }) });
const suggestReq = (token: string, slug: string, body: unknown) =>
  new Request(`http://test/api/s/${token}/${slug}/suggest`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

function doc(over: Record<string, unknown> = {}) {
  return {
    slug: "x",
    title: "X",
    sourcePath: "x.md",
    format: "md" as const,
    content: "# body",
    by: "lucas",
    ...over,
  } as Parameters<typeof publishDocOk>[0];
}

async function editableDirShare(prefix: string, label = "Folder") {
  const out = await createDirectoryShare("workspace", prefix, label, "lucas");
  if (!out.ok) throw new Error("create failed");
  await setShareEdits(out.id, true);
  return { id: out.id, token: out.shareUrl.split("/").pop()!, label };
}

describe("POST /api/s/[token]/[slug]/suggest — directory-doc suggest", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(doc({ slug: "finance-q3", path: "finance/q3", sourcePath: "finance/q3.md" }));
    await publishDocOk(doc({ slug: "marketing", path: "marketing", sourcePath: "marketing.md" }));
    await publishDocOk(
      doc({ slug: "finance-html", path: "finance/artifact", sourcePath: "finance/a.html", format: "html", content: "<p>hi</p>" }),
    );
    shareSuggestLimiter.reset();
  });

  it("201 for a published md doc under the prefix; identity forced to link:<label>", async () => {
    const { id, token, label } = await editableDirShare("finance");
    const res = await POST(suggestReq(token, "finance-q3", { content: "# revised" }), ctx(token, "finance-q3"));
    expect(res.status).toBe(201);
    const rev = await getRevision((await res.json()).suggestion.id);
    expect(rev!.content).toBe("# revised");
    expect(rev!.proposerLabel).toBe(`link:${label}`);
    expect(rev!.authorName).toBe(label);
    expect(rev!.authorKind).toBe(`link:${label}`);
    expect(rev!.shareId).toBe(id);
  });

  it("404 for a slug OUTSIDE the prefix (marketing), nothing queued", async () => {
    const { token } = await editableDirShare("finance");
    expect((await POST(suggestReq(token, "marketing", { content: "# x" }), ctx(token, "marketing"))).status).toBe(404);
    const docId = (await docIdForSlug("marketing"))!;
    expect(await listRevisions(docId)).toHaveLength(0);
  });

  it("404 for an html doc under the prefix (no editor)", async () => {
    const { token } = await editableDirShare("finance");
    expect(
      (await POST(suggestReq(token, "finance-html", { content: "<p>x</p>" }), ctx(token, "finance-html"))).status,
    ).toBe(404);
  });

  it("404 (uniform) when edits are off — same body as no-token", async () => {
    const out = await createDirectoryShare("workspace", "finance", "Folder", "lucas"); // edits default OFF
    if (!out.ok) throw new Error("create failed");
    const token = out.shareUrl.split("/").pop()!;
    const off = await POST(suggestReq(token, "finance-q3", { content: "# x" }), ctx(token, "finance-q3"));
    const unknown = await POST(suggestReq("nope", "finance-q3", { content: "# x" }), ctx("nope", "finance-q3"));
    expect(off.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await off.json()).toEqual(await unknown.json());
  });

  it("404 after the dir token is revoked", async () => {
    const { id, token } = await editableDirShare("finance");
    await revokeShare(id);
    expect((await POST(suggestReq(token, "finance-q3", { content: "# x" }), ctx(token, "finance-q3"))).status).toBe(404);
  });

  it("404 for a slug in ANOTHER space under the same prefix (space guard)", async () => {
    // A foreign space with a `finance/` doc — a directory share scoped to
    // workspace must NOT let it through (Slice 1 finding-3 guard, inherited here).
    const owner = await seedUser({ email: "foreign@test.co", displayName: "Foreign", role: "admin" });
    const otherSpace = await seedSpace({ slug: "other", ownerId: owner });
    await publishDocOk(
      doc({ slug: "finance-foreign", path: "finance/foreign", sourcePath: "finance/foreign.md", spaceId: otherSpace }),
    );
    const { token } = await editableDirShare("finance"); // scoped to workspace
    expect(
      (await POST(suggestReq(token, "finance-foreign", { content: "# x" }), ctx(token, "finance-foreign"))).status,
    ).toBe(404);
    const docId = (await docIdForSlug("finance-foreign"))!;
    expect(await listRevisions(docId)).toHaveLength(0);
  });

  it("edits ON + comments OFF stays independent (suggest 201)", async () => {
    const { id, token } = await editableDirShare("finance");
    await setShareComments(id, false);
    expect((await POST(suggestReq(token, "finance-q3", { content: "# ok" }), ctx(token, "finance-q3"))).status).toBe(201);
  });

  it("rate limit: 5 succeed, 6th → 429 (folder-wide, per share id)", async () => {
    const { token } = await editableDirShare("finance");
    for (let i = 0; i < 5; i++) {
      expect((await POST(suggestReq(token, "finance-q3", { content: `# c${i}` }), ctx(token, "finance-q3"))).status).toBe(201);
    }
    expect((await POST(suggestReq(token, "finance-q3", { content: "# over" }), ctx(token, "finance-q3"))).status).toBe(429);
  });
});
