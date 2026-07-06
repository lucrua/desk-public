import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  resetDb,
  seedAudiences,
  seedDefaultSpace,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
  publishDocOk,
  createShareOk,
} from "@/test/db";
import { HAVE_GIT, useTempDataDir, clearSpaceRepos } from "@/test/git";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import { db } from "@/db";
import {
  listEvents,
  listEventsWaiting,
  clampWaitSeconds,
  MAX_WAIT_SECONDS,
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
  // Lands in the default `workspace` space — member-visible once the
  // dev-member is seeded as a reader of it (seedDevMemberInDefaultSpace).
  format: "md" as const,
  content: "# v1",
  by: "lucas",
};

async function allKinds(): Promise<string[]> {
  const rows = await listEvents({ viewer: "admin" });
  return rows.map((r) => r.kind);
}

describe("events service", () => {
  // The accept-revision test commits to a real bare repo (truth = git) — isolate
  // those writes to a throwaway DESK_DATA_DIR and wipe repos per-test.
  let restore: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ restore } = await useTempDataDir());
  });
  afterAll(async () => {
    if (restore) await restore();
  });

  beforeEach(async () => {
    await resetDb();
    await clearSpaceRepos();
    await seedAudiences();
    // Pre-create the Phase-1 default space (inserted directly, emits no event)
    // so publishDoc doesn't lazily create it — and thereby emit a space.created
    // event — mid-test. The event-log assertions count only doc.* events.
    await seedDefaultSpace();
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
    expect(rows[0].actorName).toBe("lucas");
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
    const r1 = await setDocPath("ev-doc", "os/canon", "lucas");
    expect(r1).toBe("ok");
    const r2 = await setDocPath("ev-doc", "os/canon", "lucas"); // same → noop
    expect(r2).toBe("noop");

    const moved = (await listEvents({ viewer: "admin" })).filter(
      (e) => e.kind === "doc.moved",
    );
    expect(moved).toHaveLength(1);
    const p = moved[0].payload as Record<string, unknown>;
    expect(p).toMatchObject({ slug: "ev-doc", from_path: "", to_path: "os/canon" });
  });

  it.skipIf(!HAVE_GIT)("createRevision emits revision.proposed; accept emits doc.published + revision.decided", async () => {
    await publishDocOk(DOC);
    const doc = await getDocBySlug("ev-doc");
    const rev = await createRevision({
      slug: "ev-doc",
      authorName: "dani",
      authorKind: "member",
      scope: { viewer: "admin" },
      content: "# v1 edited",
    });
    expect(rev).not.toBeNull();

    let kinds = await allKinds();
    expect(kinds).toContain("revision.proposed");

    const res = await acceptRevision(rev!.id, { by: "lucas" });
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
      authorName: "dani",
      authorKind: "member",
      scope: { viewer: "admin" },
      content: "# nope",
    });
    await rejectRevision(rev!.id, { by: "lucas" });
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
      authorName: "dani",
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
    const res = await approveAccessRequest(reqs[0].id, { by: "lucas" });
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
          actorName: "lucas",
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

  // ── member space scoping ────────────────────────────────────────────────────

  it("member sees doc events ONLY for docs whose space is member-visible", async () => {
    // dev-member is a reader of the default `workspace` space → sees DOC's events.
    await seedDevMemberInDefaultSpace();
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    // Hidden doc lives in a SEPARATE private space the dev-member isn't in.
    const owner = await seedUser({ email: "hidden-owner@x.com", displayName: "Owner", role: "admin" });
    const hiddenSpace = await seedSpace({ slug: "hidden-space", ownerId: owner, visibility: "private" });

    await publishDocOk(DOC); // default space → visible
    await publishDocOk({ ...DOC, slug: "ev-hidden", spaceId: hiddenSpace }); // private space → hidden

    const memberRows = await listEvents({ viewer: "member", userId: memberId });
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
    await approveAccessRequest(reqs[0].id, { by: "lucas" });

    const memberRows = await listEvents({ viewer: "member" });
    expect(memberRows.map((e) => e.kind)).not.toContain("user.approved");
    // even if explicitly requested
    const filtered = await listEvents({ viewer: "member", kinds: ["user.approved"] });
    expect(filtered).toHaveLength(0);
  });

  it("member with no visible spaces sees no doc events", async () => {
    // The dev-member is NOT seeded into any space → the default `workspace`
    // (PRIVATE) doc is invisible to them.
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    await publishDocOk(DOC); // default private space, member not a member
    expect(await listEvents({ viewer: "member", userId: memberId })).toHaveLength(0);
  });

  it("comment via share link still reaches the member feed if the doc is visible", async () => {
    await seedDevMemberInDefaultSpace();
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    const pub = await publishDocOk(DOC);
    const share = await createShareOk("ev-doc", "Partner", "lucas");
    const docId = (await docIdForSlug("ev-doc"))!;
    await addComment({
      docId,
      versionId: pub.versionId,
      shareId: share.id,
      authorName: "Partner",
      authorKind: "link:Partner",
      body: "from outside",
    });
    const memberRows = await listEvents({
      viewer: "member",
      userId: memberId,
      kinds: ["comment.added"],
    });
    expect(memberRows).toHaveLength(1);
    expect((memberRows[0].payload as Record<string, unknown>).viaShare).toBe(true);
  });
});

// ── P2 board events: staff-visible, no space scoping ─────────────────────────
describe("board event scoping (card.* / bucket.*)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Pre-create the Phase-1 default space (inserted directly, emits no event)
    // so publishDoc doesn't lazily create it — and thereby emit a space.created
    // event — mid-test. The event-log assertions count only doc.* events.
    await seedDefaultSpace();
  });

  it("members see card/bucket events even with NO visible doc spaces", async () => {
    // A member with no space membership — doc events would be invisible.
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    await emitEvent(db, { kind: "card.created", payload: { cardId: 1, bucket: "backlog" }, actorName: "Alex" });
    await emitEvent(db, { kind: "bucket.created", payload: { bucketId: 1, bucketKey: "backlog" }, actorName: "Alex" });

    const memberRows = await listEvents({ viewer: "member", userId: memberId });
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
    await seedDevMemberInDefaultSpace();
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    const owner = await seedUser({ email: "hidden-owner2@x.com", displayName: "Owner", role: "admin" });
    const hiddenSpace = await seedSpace({ slug: "hidden-space2", ownerId: owner, visibility: "private" });

    await publishDocOk(DOC); // default space → visible
    await publishDocOk({ ...DOC, slug: "ev-hidden", spaceId: hiddenSpace }); // private space → hidden
    await emitEvent(db, { kind: "card.created", payload: { cardId: 7, bucket: "review" }, actorName: "Alex" });

    const rows = await listEvents({ viewer: "member", userId: memberId });
    const kinds = rows.map((e) => e.kind);
    expect(kinds).toContain("card.created"); // board event
    expect(kinds).toContain("doc.published"); // visible doc
    // hidden doc still excluded
    const slugs = rows.map((e) => (e.payload as Record<string, unknown>).slug);
    expect(slugs).not.toContain("ev-hidden");
  });
});

// ── listEventsWaiting: the optional near-real-time long-poll (Slice 5) ────────
describe("listEventsWaiting (long-poll)", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Direct insert → emits no event, so the log starts empty and the park
    // tests below start from a clean cursor.
    await seedDefaultSpace();
  });

  // The current max event id (0 if the log is empty) — used as an exclusive
  // `since` so a park starts from a clean slate regardless of seed noise.
  async function cursorNow(): Promise<number> {
    const all = await listEvents({ viewer: "admin" });
    return all.length > 0 ? all[all.length - 1].id : 0;
  }

  it("clampWaitSeconds bounds the wait to [0, 55]", () => {
    expect(MAX_WAIT_SECONDS).toBe(55);
    expect(clampWaitSeconds(0)).toBe(0);
    expect(clampWaitSeconds(5)).toBe(5);
    expect(clampWaitSeconds(55)).toBe(55);
    expect(clampWaitSeconds(100)).toBe(55); // >55 → clamped to 55
    expect(clampWaitSeconds(-5)).toBe(0); // negative → 0 (immediate)
    expect(clampWaitSeconds(undefined)).toBe(0);
    expect(clampWaitSeconds(null)).toBe(0);
    expect(clampWaitSeconds(Number.NaN)).toBe(0);
    expect(clampWaitSeconds(3.9)).toBe(3); // floored
  });

  it("returns IMMEDIATELY when events already match (no wait)", async () => {
    await emitEvent(db, {
      kind: "card.created",
      payload: { cardId: 1, bucket: "backlog" },
      actorName: "Alex",
    });
    const t0 = Date.now();
    const rows = await listEventsWaiting({ viewer: "admin" }, 5);
    const elapsed = Date.now() - t0;
    expect(rows.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500); // did not park
  });

  it("wait <= 0 behaves exactly like listEvents (no park, may be empty)", async () => {
    const since = await cursorNow();
    const t0 = Date.now();
    const rows = await listEventsWaiting({ viewer: "admin", since }, 0);
    const elapsed = Date.now() - t0;
    expect(rows).toHaveLength(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("with nothing pending and a short wait, returns empty after ~the timeout", async () => {
    const since = await cursorNow();
    const t0 = Date.now();
    const rows = await listEventsWaiting({ viewer: "admin", since }, 1);
    const elapsed = Date.now() - t0;
    expect(rows).toHaveLength(0);
    expect(elapsed).toBeGreaterThanOrEqual(900); // actually waited ~1s
    expect(elapsed).toBeLessThan(2500);
  });

  it("an event inserted mid-wait returns promptly with it", async () => {
    const since = await cursorNow();
    const t0 = Date.now();
    setTimeout(() => {
      void emitEvent(db, {
        kind: "card.created",
        payload: { cardId: 9, bucket: "review" },
        actorName: "Alex",
      });
    }, 150);
    const rows = await listEventsWaiting({ viewer: "admin", since }, 5);
    const elapsed = Date.now() - t0;
    expect(rows.some((r) => r.kind === "card.created")).toBe(true);
    expect(elapsed).toBeLessThan(3000); // well before the 5s deadline
  });

  it("respects an abort signal — returns promptly and empty (no full wait)", async () => {
    const since = await cursorNow();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    const rows = await listEventsWaiting({ viewer: "admin", since }, 30, ac.signal);
    const elapsed = Date.now() - t0;
    expect(rows).toHaveLength(0);
    expect(elapsed).toBeLessThan(1500); // aborted — did NOT wait 30s
  });

  it("an already-aborted signal returns immediately", async () => {
    const since = await cursorNow();
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    const rows = await listEventsWaiting({ viewer: "admin", since }, 30, ac.signal);
    expect(rows).toHaveLength(0);
    expect(Date.now() - t0).toBeLessThan(500);
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
