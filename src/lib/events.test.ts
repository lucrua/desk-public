import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk, createShareOk } from "@/test/db";
import { db } from "@/db";
import {
  listEvents,
  parseKindsParam,
  EVENT_KINDS,
  emitEvent,
} from "./events";
import { unpublishDoc, setDocPath } from "@/lib/docs";
import { createRevision, acceptRevision, rejectRevision } from "@/lib/revisions";
import { addComment, docIdForSlug } from "@/lib/comments";
import { approveAccessRequest } from "@/lib/access-requests";
import { getDocBySlug } from "@/lib/docs";

const DOC = {
  slug: "ev-doc",
  title: "Ev Doc",
  sourcePath: "os/ev.md",
  audience: "team", // member-visible (seeded)
  format: "md" as const,
  content: "# v1",
  by: "admin",
};

const HIDDEN_DOC = {
  ...DOC,
  slug: "ev-hidden",
  audience: "alice", // hidden from members (seeded)
};

async function allKinds(): Promise<string[]> {
  const rows = await listEvents({ viewer: "admin" });
  return rows.map((r) => r.kind);
}

describe("events service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  // ── emission per mutation ──────────────────────────────────────────────────

  it("publishDoc emits doc.published with reference-only payload (no content)", async () => {
    const pub = await publishDocOk(DOC);
    const rows = await listEvents({ viewer: "admin" });
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("doc.published");
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.slug).toBe("ev-doc");
    expect(payload.versionId).toBe(pub.versionId);
    // NEVER the content.
    expect(JSON.stringify(payload)).not.toContain("# v1");
    expect(payload.content).toBeUndefined();
    expect(rows[0].actorName).toBe("admin");
  });

  it("a no-op republish (same content) emits NO new event", async () => {
    await publishDocOk(DOC);
    await publishDocOk(DOC); // identical content → no new version
    expect(await allKinds()).toEqual(["doc.published"]);
  });

  it("a real republish (new content) emits a second doc.published", async () => {
    await publishDocOk(DOC);
    await publishDocOk({ ...DOC, content: "# v2" });
    expect(await allKinds()).toEqual(["doc.published", "doc.published"]);
  });

  it("unpublishDoc emits doc.unpublished once (idempotent — second is silent)", async () => {
    await publishDocOk(DOC);
    await unpublishDoc("ev-doc");
    await unpublishDoc("ev-doc"); // already unpublished → no event
    expect(await allKinds()).toEqual(["doc.published", "doc.unpublished"]);
  });

  it("setDocPath emits doc.moved {slug, from_path, to_path}; noop move is silent", async () => {
    await publishDocOk(DOC);
    const r1 = await setDocPath("ev-doc", "os/canon", "admin");
    expect(r1).toBe("ok");
    const r2 = await setDocPath("ev-doc", "os/canon", "admin"); // same → noop
    expect(r2).toBe("noop");

    const moved = (await listEvents({ viewer: "admin" })).filter(
      (e) => e.kind === "doc.moved",
    );
    expect(moved).toHaveLength(1);
    const p = moved[0].payload as Record<string, unknown>;
    expect(p).toMatchObject({ slug: "ev-doc", from_path: "", to_path: "os/canon" });
  });

  it("createRevision emits revision.proposed; accept emits doc.published + revision.decided", async () => {
    await publishDocOk(DOC);
    const doc = await getDocBySlug("ev-doc");
    const rev = await createRevision({
      slug: "ev-doc",
      authorName: "bob",
      authorKind: "member",
      scope: { viewer: "admin" },
      content: "# v1 edited",
    });
    expect(rev).not.toBeNull();

    let kinds = await allKinds();
    expect(kinds).toContain("revision.proposed");

    const res = await acceptRevision(rev!.id, { by: "admin" });
    expect(res.ok).toBe(true);

    kinds = await allKinds();
    // doc.published (initial) + revision.proposed + doc.published (accept) +
    // revision.decided
    expect(kinds.filter((k) => k === "doc.published")).toHaveLength(2);
    expect(kinds.filter((k) => k === "revision.decided")).toHaveLength(1);
    const decided = (await listEvents({ viewer: "admin" })).find(
      (e) => e.kind === "revision.decided",
    )!;
    expect((decided.payload as Record<string, unknown>).decision).toBe("accepted");
    expect(doc).not.toBeNull();
  });

  it("rejectRevision emits revision.decided {decision: rejected}", async () => {
    await publishDocOk(DOC);
    const rev = await createRevision({
      slug: "ev-doc",
      authorName: "bob",
      authorKind: "member",
      scope: { viewer: "admin" },
      content: "# nope",
    });
    await rejectRevision(rev!.id, { by: "admin" });
    const decided = (await listEvents({ viewer: "admin" })).find(
      (e) => e.kind === "revision.decided",
    )!;
    expect((decided.payload as Record<string, unknown>).decision).toBe("rejected");
  });

  it("addComment emits comment.added with no body in the payload", async () => {
    const pub = await publishDocOk(DOC);
    const docId = (await docIdForSlug("ev-doc"))!;
    await addComment({
      docId,
      versionId: pub.versionId,
      authorName: "bob",
      authorKind: "member",
      body: "secret comment body",
    });
    const added = (await listEvents({ viewer: "admin" })).find(
      (e) => e.kind === "comment.added",
    )!;
    expect(added).toBeDefined();
    expect(JSON.stringify(added.payload)).not.toContain("secret comment body");
    expect((added.payload as Record<string, unknown>).viaShare).toBe(false);
  });

  it("approveAccessRequest emits user.approved (no docId)", async () => {
    await db
      .insert((await import("@/db/schema")).accessRequests)
      .values({ email: "new@x.com" });
    const reqs = await (await import("@/lib/access-requests")).listAccessRequests();
    const res = await approveAccessRequest(reqs[0].id, { by: "admin" });
    expect(res.status).toBe("ok");
    const approved = (await listEvents({ viewer: "admin" })).find(
      (e) => e.kind === "user.approved",
    )!;
    expect(approved).toBeDefined();
    expect((approved.payload as Record<string, unknown>).email).toBe("new@x.com");
  });

  // ── transactional rollback: a failed publish emits nothing ──────────────────

  it("a publish that throws mid-transaction emits NO event (atomic rollback)", async () => {
    await publishDocOk(DOC); // 1 event so far
    const before = (await listEvents({ viewer: "admin" })).length;

    // Force a failure AFTER the doc.published append would run by wrapping a
    // transaction that emits an event then throws — the event must roll back.
    await expect(
      db.transaction(async (tx) => {
        await emitEvent(tx, {
          kind: "doc.published",
          docId: 1,
          payload: { slug: "ev-doc", versionId: 999 },
          actorName: "admin",
        });
        throw new Error("boom — force rollback");
      }),
    ).rejects.toThrow("boom");

    const after = (await listEvents({ viewer: "admin" })).length;
    expect(after).toBe(before); // nothing committed
  });

  // ── cursor + kinds filter ───────────────────────────────────────────────────

  it("since is an exclusive cursor; results are oldest-first", async () => {
    await publishDocOk(DOC);
    await publishDocOk({ ...DOC, content: "# v2" });
    const all = await listEvents({ viewer: "admin" });
    expect(all.map((e) => e.id)).toEqual([...all.map((e) => e.id)].sort((a, b) => a - b));

    const afterFirst = await listEvents({ viewer: "admin", since: all[0].id });
    expect(afterFirst.map((e) => e.id)).toEqual([all[1].id]);
  });

  it("kinds filters to the requested subset", async () => {
    await publishDocOk(DOC);
    await unpublishDoc("ev-doc");
    const onlyUnpub = await listEvents({ viewer: "admin", kinds: ["doc.unpublished"] });
    expect(onlyUnpub.map((e) => e.kind)).toEqual(["doc.unpublished"]);
  });

  it("limit clamps the page size", async () => {
    await publishDocOk(DOC);
    await publishDocOk({ ...DOC, content: "# v2" });
    await publishDocOk({ ...DOC, content: "# v3" });
    const page = await listEvents({ viewer: "admin", limit: 2 });
    expect(page).toHaveLength(2);
  });

  // ── member audience scoping ─────────────────────────────────────────────────

  it("member sees doc events ONLY for member-visible audiences", async () => {
    await publishDocOk(DOC); // team → visible
    await publishDocOk(HIDDEN_DOC); // alice → hidden

    const memberRows = await listEvents({ viewer: "member" });
    const slugs = memberRows.map((e) => (e.payload as Record<string, unknown>).slug);
    expect(slugs).toContain("ev-doc");
    expect(slugs).not.toContain("ev-hidden");

    // Admin sees both.
    const adminRows = await listEvents({ viewer: "admin" });
    const adminSlugs = adminRows.map((e) => (e.payload as Record<string, unknown>).slug);
    expect(adminSlugs).toEqual(expect.arrayContaining(["ev-doc", "ev-hidden"]));
  });

  it("member NEVER sees user.approved (admin-only kind)", async () => {
    await db
      .insert((await import("@/db/schema")).accessRequests)
      .values({ email: "p@x.com" });
    const reqs = await (await import("@/lib/access-requests")).listAccessRequests();
    await approveAccessRequest(reqs[0].id, { by: "admin" });

    const memberRows = await listEvents({ viewer: "member" });
    expect(memberRows.map((e) => e.kind)).not.toContain("user.approved");
    // even if explicitly requested
    const filtered = await listEvents({ viewer: "member", kinds: ["user.approved"] });
    expect(filtered).toHaveLength(0);
  });

  it("member with zero visible audiences sees no events", async () => {
    // Make team hidden too.
    const { db: d } = await import("@/db");
    const { audiences } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await d.update(audiences).set({ memberVisible: 0 }).where(eq(audiences.key, "team"));
    await publishDocOk(DOC);
    expect(await listEvents({ viewer: "member" })).toHaveLength(0);
  });

  it("comment via share link still reaches the member feed if the doc is visible", async () => {
    const pub = await publishDocOk(DOC);
    const share = await createShareOk("ev-doc", "Partner", "admin");
    const docId = (await docIdForSlug("ev-doc"))!;
    await addComment({
      docId,
      versionId: pub.versionId,
      shareId: share.id,
      authorName: "Partner",
      authorKind: "link:Partner",
      body: "from outside",
    });
    const memberRows = await listEvents({ viewer: "member", kinds: ["comment.added"] });
    expect(memberRows).toHaveLength(1);
    expect((memberRows[0].payload as Record<string, unknown>).viaShare).toBe(true);
  });
});

// ── P2 board events: staff-visible, no audience scoping ──────────────────────
describe("board event scoping (card.* / bucket.*)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("members see card/bucket events even with ZERO visible audiences", async () => {
    // Hide every audience — doc events would be invisible to a member.
    const { audiences } = await import("@/db/schema");
    await db.update(audiences).set({ memberVisible: 0 });
    await emitEvent(db, { kind: "card.created", payload: { cardId: 1, bucket: "backlog" }, actorName: "Alex" });
    await emitEvent(db, { kind: "bucket.created", payload: { bucketId: 1, bucketKey: "backlog" }, actorName: "Alex" });

    const memberRows = await listEvents({ viewer: "member" });
    const kinds = memberRows.map((e) => e.kind);
    expect(kinds).toContain("card.created");
    expect(kinds).toContain("bucket.created");
  });

  it("admins see board events too, alongside doc events", async () => {
    await publishDocOk(DOC);
    await emitEvent(db, { kind: "card.moved", payload: { cardId: 1, from: "backlog", to: "done" }, actorName: "Alex" });
    const adminKinds = (await listEvents({ viewer: "admin" })).map((e) => e.kind);
    expect(adminKinds).toContain("card.moved");
    expect(adminKinds).toContain("doc.published");
  });

  it("a member's board events come through alongside their visible doc events", async () => {
    await publishDocOk(DOC); // team → visible
    await publishDocOk(HIDDEN_DOC); // alice → hidden
    await emitEvent(db, { kind: "card.created", payload: { cardId: 7, bucket: "review" }, actorName: "Alex" });

    const rows = await listEvents({ viewer: "member" });
    const kinds = rows.map((e) => e.kind);
    expect(kinds).toContain("card.created"); // board event
    expect(kinds).toContain("doc.published"); // visible doc
    // hidden doc still excluded
    const slugs = rows.map((e) => (e.payload as Record<string, unknown>).slug);
    expect(slugs).not.toContain("ev-hidden");
  });
});

describe("parseKindsParam", () => {
  it("null/empty → [] (no filter)", () => {
    expect(parseKindsParam(null)).toEqual([]);
    expect(parseKindsParam(undefined)).toEqual([]);
    expect(parseKindsParam("")).toEqual([]);
    expect(parseKindsParam("   ")).toEqual([]);
  });

  it("parses + dedupes known kinds in input order", () => {
    expect(parseKindsParam("doc.published,comment.added,doc.published")).toEqual([
      "doc.published",
      "comment.added",
    ]);
  });

  it("unknown kind → null", () => {
    expect(parseKindsParam("doc.published,bogus")).toBeNull();
    expect(parseKindsParam("card.bogus")).toBeNull();
  });

  it("accepts the P2 board kinds", () => {
    expect(parseKindsParam("card.moved,bucket.created")).toEqual([
      "card.moved",
      "bucket.created",
    ]);
  });

  it("every EVENT_KINDS member is accepted", () => {
    expect(parseKindsParam(EVENT_KINDS.join(","))).toEqual([...EVENT_KINDS]);
  });
});
