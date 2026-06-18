import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedBuckets } from "@/test/db";
import { db, schema } from "@/db";
import type { Principal } from "@/lib/auth";
import {
  createCard,
  listCards,
  getCard,
  getCardActivity,
  moveCard,
  updateCard,
  assignCard,
  setCardArchived,
  canEditCard,
  resolveMemberUserId,
} from "./cards";
import { listEvents } from "./events";
import { MAX_CARD_BODY_CHARS, MAX_CHECKLIST_ITEMS } from "./limits";

async function seedUser(displayName: string, email: string): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ email: email.toLowerCase(), displayName, role: "member" })
    .returning({ id: schema.users.id });
  return u.id;
}

const adminP: Principal = { kind: "admin", name: "Alex", email: "alex@x.com" };
const memberP = (email: string): Principal => ({ kind: "member", name: "Sam", email });

describe("cards service", () => {
  let buckets: Awaited<ReturnType<typeof seedBuckets>>;
  beforeEach(async () => {
    await resetDb();
    buckets = await seedBuckets();
  });
  const bucketId = (key: string) => buckets.find((b) => b.key === key)!.id;

  describe("createCard + validation", () => {
    it("creates at the end of its bucket and emits card.created with bucket key (no body)", async () => {
      const r = await createCard({ title: "First", bucketId: bucketId("backlog"), actorName: "Alex" });
      expect(r.ok).toBe(true);
      const events = await listEvents({ viewer: "admin", kinds: ["card.created"] });
      const ev = events.at(-1)!;
      expect(ev.payload).toMatchObject({ bucket: "backlog" });
      expect(ev.payload).toHaveProperty("cardId");
      // payload carries NO body
      expect(JSON.stringify(ev.payload)).not.toContain("First");
    });

    it("resolves bucket by key", async () => {
      const r = await createCard({ title: "ByKey", bucketKey: "review", actorName: "Alex" });
      expect(r.ok && r.card.bucketKey).toBe("review");
    });

    it("rejects empty title, oversize body, oversize checklist", async () => {
      expect((await createCard({ title: "  ", bucketId: bucketId("backlog"), actorName: "Alex" })).ok).toBe(false);
      const bigBody = "x".repeat(MAX_CARD_BODY_CHARS + 1);
      expect((await createCard({ title: "t", body: bigBody, bucketId: bucketId("backlog"), actorName: "Alex" })).ok).toBe(false);
      const bigList = Array.from({ length: MAX_CHECKLIST_ITEMS + 1 }, (_, i) => ({ text: `i${i}`, done: false }));
      expect((await createCard({ title: "t", checklist: bigList, bucketId: bucketId("backlog"), actorName: "Alex" })).ok).toBe(false);
    });

    it("rejects malformed checklist items", async () => {
      const r = await createCard({ title: "t", checklist: [{ text: "", done: false }], bucketId: bucketId("backlog"), actorName: "Alex" });
      expect(r.ok).toBe(false);
    });

    it("404s an unknown bucket / owner", async () => {
      expect((await createCard({ title: "t", bucketId: 99999, actorName: "Alex" })).ok).toBe(false);
      expect((await createCard({ title: "t", bucketId: bucketId("backlog"), ownerUserId: 99999, actorName: "Alex" })).ok).toBe(false);
    });
  });

  describe("fractional ordering + renormalize", () => {
    it("inserts cards at the end, then moves between neighbors with fractional positions", async () => {
      const a = await createCard({ title: "A", bucketId: bucketId("backlog"), actorName: "Alex" });
      const b = await createCard({ title: "B", bucketId: bucketId("backlog"), actorName: "Alex" });
      const c = await createCard({ title: "C", bucketId: bucketId("backlog"), actorName: "Alex" });
      expect(a.ok && b.ok && c.ok).toBe(true);
      const aId = a.ok ? a.card.id : 0;
      const cId = c.ok ? c.card.id : 0;

      // Move C to slot 1 (between A and B) → fractional position
      await moveCard(cId, bucketId("backlog"), 1, "Alex");
      const order = (await listCards({ bucketId: bucketId("backlog") })).map((x) => x.title);
      expect(order).toEqual(["A", "C", "B"]);

      // The moved card's position should sit strictly between A and B.
      const list = await listCards({ bucketId: bucketId("backlog") });
      const posA = list.find((x) => x.title === "A")!.position;
      const posC = list.find((x) => x.title === "C")!.position;
      const posB = list.find((x) => x.title === "B")!.position;
      expect(posC).toBeGreaterThan(posA);
      expect(posC).toBeLessThan(posB);
      void aId;
    });

    it("renormalizes when float positions collapse to a tiny gap", async () => {
      const a = await createCard({ title: "A", bucketId: bucketId("backlog"), actorName: "Alex" });
      const b = await createCard({ title: "B", bucketId: bucketId("backlog"), actorName: "Alex" });
      const moverId = (await createCard({ title: "M", bucketId: bucketId("review"), actorName: "Alex" })).ok
        ? (await listCards({ bucketId: bucketId("review") }))[0].id
        : 0;
      expect(a.ok && b.ok).toBe(true);
      const aId = a.ok ? a.card.id : 0;
      const bId = b.ok ? b.card.id : 0;

      // Force a tiny gap between A and B directly, then move M into slot 1.
      await db.update(schema.cards).set({ position: 1 }).where(eqId(aId));
      await db.update(schema.cards).set({ position: 1 + 1e-12 }).where(eqId(bId));

      await moveCard(moverId, bucketId("backlog"), 1, "Alex");
      const order = (await listCards({ bucketId: bucketId("backlog") })).map((x) => x.title);
      expect(order).toEqual(["A", "M", "B"]);
      // After renormalize, positions are spread out again (all distinct, ascending)
      const positions = (await listCards({ bucketId: bucketId("backlog") })).map((x) => x.position);
      for (let i = 1; i < positions.length; i++) expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    });
  });

  describe("authz matrix (canEditCard)", () => {
    it("admin edits anything; member edits only own; non-owner member denied", async () => {
      const samId = await seedUser("Sam", "sam@x.com");
      const jordanId = await seedUser("Jordan", "jordan@x.com");
      const own = { ownerUserId: samId };
      const other = { ownerUserId: jordanId };
      const unowned = { ownerUserId: null };

      expect(canEditCard(adminP, own, null)).toBe(true);
      expect(canEditCard(adminP, unowned, null)).toBe(true);

      // member Sam resolves to samId
      const sam = memberP("sam@x.com");
      const samUid = await resolveMemberUserId(sam);
      expect(samUid).toBe(samId);
      expect(canEditCard(sam, own, samUid)).toBe(true);
      expect(canEditCard(sam, other, samUid)).toBe(false);
      expect(canEditCard(sam, unowned, samUid)).toBe(false);
    });

    it("a member with no users row owns nothing", async () => {
      const ghost = memberP("nobody@x.com");
      const uid = await resolveMemberUserId(ghost);
      expect(uid).toBeNull();
      expect(canEditCard(ghost, { ownerUserId: 1 }, uid)).toBe(false);
    });

    it("anonymous resolves to null and can't edit", async () => {
      const uid = await resolveMemberUserId({ kind: "anonymous" });
      expect(uid).toBeNull();
      expect(canEditCard({ kind: "anonymous" }, { ownerUserId: null }, uid)).toBe(false);
    });
  });

  describe("move / update / assign / archive events", () => {
    it("card.moved carries from/to bucket keys", async () => {
      const c = await createCard({ title: "X", bucketId: bucketId("backlog"), actorName: "Alex" });
      const id = c.ok ? c.card.id : 0;
      await moveCard(id, bucketId("done"), null, "Alex");
      const events = await listEvents({ viewer: "admin", kinds: ["card.moved"] });
      expect(events.at(-1)!.payload).toMatchObject({ from: "backlog", to: "done" });
    });

    it("card.updated lists changed fields; card.assigned + card.archived emit", async () => {
      const ownerId = await seedUser("Sam", "sam@x.com");
      const c = await createCard({ title: "X", bucketId: bucketId("backlog"), actorName: "Alex" });
      const id = c.ok ? c.card.id : 0;
      await updateCard(id, { title: "Y", checklist: [{ text: "a", done: true }], actorName: "Alex" });
      await assignCard(id, ownerId, "Alex");
      await setCardArchived(id, true, "Alex");

      const upd = await listEvents({ viewer: "admin", kinds: ["card.updated"] });
      expect(upd.at(-1)!.payload).toMatchObject({ fields: expect.arrayContaining(["title", "checklist"]) });
      const asg = await listEvents({ viewer: "admin", kinds: ["card.assigned"] });
      expect(asg.at(-1)!.payload).toMatchObject({ ownerUserId: ownerId });
      const arc = await listEvents({ viewer: "admin", kinds: ["card.archived"] });
      expect(arc.at(-1)!.payload).toMatchObject({ archived: true, bucket: "backlog" });
    });

    it("getCardActivity returns this card's card.* events oldest-first", async () => {
      const c = await createCard({ title: "X", bucketId: bucketId("backlog"), actorName: "Alex" });
      const id = c.ok ? c.card.id : 0;
      await moveCard(id, bucketId("review"), null, "Alex");
      const trail = await getCardActivity(id);
      expect(trail.map((e) => e.kind)).toEqual(["card.created", "card.moved"]);
      // other cards' events don't leak in
      const other = await createCard({ title: "Other", bucketId: bucketId("backlog"), actorName: "Alex" });
      const otherTrail = await getCardActivity(other.ok ? other.card.id : 0);
      expect(otherTrail.map((e) => e.kind)).toEqual(["card.created"]);
    });
  });

  describe("listCards filters", () => {
    it("excludes archived by default; includeArchived shows them", async () => {
      const c = await createCard({ title: "X", bucketId: bucketId("backlog"), actorName: "Alex" });
      const id = c.ok ? c.card.id : 0;
      await setCardArchived(id, true, "Alex");
      expect(await listCards({})).toHaveLength(0);
      expect(await listCards({ includeArchived: true })).toHaveLength(1);
    });

    it("filters by owner and bucket", async () => {
      const samId = await seedUser("Sam", "sam@x.com");
      await createCard({ title: "owned", bucketId: bucketId("backlog"), ownerUserId: samId, actorName: "Alex" });
      await createCard({ title: "unowned", bucketId: bucketId("review"), actorName: "Alex" });
      expect((await listCards({ ownerUserId: samId })).map((c) => c.title)).toEqual(["owned"]);
      expect((await listCards({ bucketId: bucketId("review") })).map((c) => c.title)).toEqual(["unowned"]);
    });
  });

  it("getCard returns null for unknown id", async () => {
    expect(await getCard(99999)).toBeNull();
  });
});

import { eq } from "drizzle-orm";
function eqId(id: number) {
  return eq(schema.cards.id, id);
}
