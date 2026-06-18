import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedBuckets } from "@/test/db";
import { db, schema } from "@/db";
import {
  listBuckets,
  createBucket,
  renameBucket,
  reorderBuckets,
  deleteBucket,
  deriveBucketKey,
  getBucket,
} from "./buckets";
import { createCard } from "./cards";
import { listEvents } from "./events";

describe("buckets service", () => {
  beforeEach(async () => {
    await resetDb();
  });

  describe("deriveBucketKey", () => {
    it("slugifies a label", () => {
      expect(deriveBucketKey("In Progress")).toBe("in-progress");
      expect(deriveBucketKey("  Blocked!! ")).toBe("blocked");
      expect(deriveBucketKey("QA / Review")).toBe("qa-review");
    });
    it("returns empty for nothing usable", () => {
      expect(deriveBucketKey("***")).toBe("");
    });
  });

  describe("listBuckets", () => {
    it("returns seeded buckets in position order with live card counts", async () => {
      await seedBuckets();
      const list = await listBuckets();
      expect(list.map((b) => b.key)).toEqual(["backlog", "in-progress", "review", "done"]);
      expect(list.every((b) => b.cardCount === 0)).toBe(true);
    });

    it("counts only LIVE (non-archived) cards", async () => {
      const [backlog] = await seedBuckets();
      const c1 = await createCard({ title: "a", bucketId: backlog.id, actorName: "Alex" });
      await createCard({ title: "b", bucketId: backlog.id, actorName: "Alex" });
      expect(c1.ok).toBe(true);
      // archive all
      await db.update(schema.cards).set({ archivedAt: new Date() });
      const list = await listBuckets();
      const backlogRow = list.find((b) => b.key === "backlog")!;
      // both archived now (no where → all) → 0 live
      expect(backlogRow.cardCount).toBe(0);
    });
  });

  describe("createBucket", () => {
    it("creates at the end of the order and emits bucket.created", async () => {
      await seedBuckets();
      const b = await createBucket({ label: "Blocked", actorName: "Alex" });
      expect(b).not.toBeNull();
      expect(b!.key).toBe("blocked");
      expect(b!.position).toBe(5);
      const events = await listEvents({ viewer: "admin", kinds: ["bucket.created"] });
      expect(events.at(-1)!.payload).toMatchObject({ bucketKey: "blocked" });
    });

    it("accepts an explicit key", async () => {
      const b = await createBucket({ label: "Quality Assurance", key: "qa", actorName: "Alex" });
      expect(b!.key).toBe("qa");
    });

    it("rejects a duplicate key (null)", async () => {
      await seedBuckets();
      const b = await createBucket({ label: "Backlog", actorName: "Alex" });
      expect(b).toBeNull();
    });

    it("rejects an empty label and an unsluggable label", async () => {
      expect(await createBucket({ label: "   ", actorName: "Alex" })).toBeNull();
      expect(await createBucket({ label: "***", actorName: "Alex" })).toBeNull();
    });
  });

  describe("renameBucket", () => {
    it("renames (label only) and emits bucket.updated", async () => {
      const [backlog] = await seedBuckets();
      const r = await renameBucket(backlog.id, "To Do", "Alex");
      expect(r).toBe("ok");
      const got = await getBucket(backlog.id);
      expect(got!.label).toBe("To Do");
      expect(got!.key).toBe("backlog"); // key immutable
      const events = await listEvents({ viewer: "admin", kinds: ["bucket.updated"] });
      expect(events.length).toBeGreaterThan(0);
    });
    it("rejects empty + unknown id", async () => {
      const [b] = await seedBuckets();
      expect(await renameBucket(b.id, "  ", "Alex")).toBe("invalid");
      expect(await renameBucket(99999, "X", "Alex")).toBe("not-found");
    });
  });

  describe("reorderBuckets", () => {
    it("renumbers to the given order; rejects partial orders", async () => {
      const seeded = await seedBuckets();
      const ids = seeded.map((b) => b.id);
      const reversed = [...ids].reverse();
      expect(await reorderBuckets(reversed, "Alex")).toBe("ok");
      const list = await listBuckets();
      expect(list.map((b) => b.key)).toEqual(["done", "review", "in-progress", "backlog"]);
      // partial (missing one) → not-found
      expect(await reorderBuckets(ids.slice(0, 3), "Alex")).toBe("not-found");
      // unknown id → not-found
      expect(await reorderBuckets([...ids.slice(0, 3), 99999], "Alex")).toBe("not-found");
    });
  });

  describe("deleteBucket", () => {
    it("deletes an empty bucket and emits bucket.deleted", async () => {
      const [backlog] = await seedBuckets();
      const r = await deleteBucket(backlog.id, "Alex");
      expect(r).toBe("ok");
      expect(await getBucket(backlog.id)).toBeNull();
      const events = await listEvents({ viewer: "admin", kinds: ["bucket.deleted"] });
      expect(events.at(-1)!.payload).toMatchObject({ bucketKey: "backlog" });
    });

    it("refuses when a live card references it (in-use)", async () => {
      const [backlog] = await seedBuckets();
      await createCard({ title: "x", bucketId: backlog.id, actorName: "Alex" });
      expect(await deleteBucket(backlog.id, "Alex")).toBe("in-use");
    });

    it("refuses when an ARCHIVED card references it (restore would orphan)", async () => {
      const [backlog] = await seedBuckets();
      const c = await createCard({ title: "x", bucketId: backlog.id, actorName: "Alex" });
      expect(c.ok).toBe(true);
      await db.update(schema.cards).set({ archivedAt: new Date() });
      expect(await deleteBucket(backlog.id, "Alex")).toBe("in-use");
    });

    it("not-found for unknown id", async () => {
      expect(await deleteBucket(99999, "Alex")).toBe("not-found");
    });
  });
});
