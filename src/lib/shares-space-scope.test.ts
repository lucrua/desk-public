import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { shares, docs } from "@/db/schema";
import { resetDb, publishDocOk, seedUser, seedSpace, createShareOk } from "@/test/db";
import {
  createDirectoryShare,
  resolveDirectoryShare,
  listDocsUnderShare,
  resolveShareDoc,
  backfillShareSpaceIds,
} from "./shares";
import { GET as rawGet } from "@/app/api/s/[token]/[slug]/raw/route";

// ─────────────────────────────────────────────────────────────────────────────
// Slice 1 — directory-share space scoping (finding 3: the cross-space leak).
//
// Two spaces (A, B) each publish `reports/x.md`. A directory share on prefix
// "reports" is minted AGAINST space A. It must expose ONLY space A's doc — never
// space B's — both in the resolved index (listDocsUnderShare) AND via the per-doc
// route (resolveShareDoc / GET /api/s/[token]/[slug]/raw).
// ─────────────────────────────────────────────────────────────────────────────

async function seedTwoSpacesWithReports(): Promise<{ spaceA: number; spaceB: number }> {
  const owner = await seedUser({ email: "owner@test.local", displayName: "Owner", role: "admin" });
  const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
  const spaceB = await seedSpace({ slug: "space-b", ownerId: owner });
  await publishDocOk({
    slug: "a-report", title: "A Report", sourcePath: "reports/x.md", path: "reports",
    format: "md", content: "# A body", by: "lucas", spaceId: spaceA,
  });
  await publishDocOk({
    slug: "b-report", title: "B Report", sourcePath: "reports/x.md", path: "reports",
    format: "md", content: "# B body", by: "lucas", spaceId: spaceB,
  });
  return { spaceA, spaceB };
}

const rawCtx = (token: string, slug: string) => ({ params: Promise.resolve({ token, slug }) });
const rawReq = (token: string, slug: string) =>
  new Request(`http://test/api/s/${token}/${slug}/raw`, { method: "GET" });

describe("directory-share space scoping (finding 3 leak)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a share on space A's `reports` exposes ONLY space A's doc in the index", async () => {
    await seedTwoSpacesWithReports();
    const out = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!out.ok) throw new Error(`create failed: ${out.error}`);
    const res = await resolveDirectoryShare(out.token);
    expect(res).not.toBeNull();
    const entries = await listDocsUnderShare(res!.shareId);
    const slugs = entries.map((e) => e.slug).sort();
    expect(slugs).toEqual(["a-report"]);
    expect(slugs).not.toContain("b-report");
  });

  it("the per-doc resolver returns space A's doc but NOT space B's same-prefix doc", async () => {
    await seedTwoSpacesWithReports();
    const out = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!out.ok) throw new Error(`create failed: ${out.error}`);
    const a = await resolveShareDoc(out.token, "a-report");
    expect(a).not.toBeNull();
    expect(a!.version.content).toBe("# A body");
    // The leak: b-report is under `reports` too, but in space B → uniform null.
    expect(await resolveShareDoc(out.token, "b-report")).toBeNull();
  });

  it("the per-doc raw route serves space A's doc (200) and 404s space B's", async () => {
    await seedTwoSpacesWithReports();
    const out = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!out.ok) throw new Error(`create failed: ${out.error}`);
    const token = out.shareUrl.split("/").pop()!;

    const okRes = await rawGet(rawReq(token, "a-report"), rawCtx(token, "a-report"));
    expect(okRes.status).toBe(200);
    expect(await okRes.text()).toBe("# A body");

    const leakRes = await rawGet(rawReq(token, "b-report"), rawCtx(token, "b-report"));
    expect(leakRes.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createDirectoryShare — requires a valid space (going-forward guard)
// ─────────────────────────────────────────────────────────────────────────────

describe("createDirectoryShare — space required", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("unknown space slug → { ok:false, error:'unknown-space' }", async () => {
    const out = await createDirectoryShare("no-such-space", "reports", "Reports", "lucas");
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe("unknown-space");
  });

  it("valid space → stores the space_id on the share row", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    await publishDocOk({
      slug: "r", title: "R", sourcePath: "reports/r.md", path: "reports",
      format: "md", content: "# r", by: "lucas", spaceId: spaceA,
    });
    const out = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!out.ok) throw new Error(`create failed: ${out.error}`);
    const [row] = await db.select({ spaceId: shares.spaceId }).from(shares).where(eq(shares.id, out.id));
    expect(row.spaceId).toBe(spaceA);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// backfillShareSpaceIds — the one-shot boot backfill (D-C7 fail-closed)
// ─────────────────────────────────────────────────────────────────────────────

/** Force a share back to the legacy state (space_id null) to simulate a
 *  pre-migration row that the backfill must reconcile. */
async function clearSpaceId(shareId: number): Promise<void> {
  await db.update(shares).set({ spaceId: null }).where(eq(shares.id, shareId));
}

describe("backfillShareSpaceIds", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("doc share → space_id set from the doc's space", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    await publishDocOk({
      slug: "d", title: "D", sourcePath: "d.md", path: "",
      format: "md", content: "# d", by: "lucas", spaceId: spaceA,
    });
    const share = await createShareOk("d", "Link", "lucas");
    await clearSpaceId(share.id);

    const r = await backfillShareSpaceIds();
    expect(r.docFilled).toBe(1);
    const [row] = await db.select({ spaceId: shares.spaceId }).from(shares).where(eq(shares.id, share.id));
    expect(row.spaceId).toBe(spaceA);
  });

  it("directory share matching exactly ONE space → space_id set, stays active", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    await publishDocOk({
      slug: "a-report", title: "A", sourcePath: "reports/x.md", path: "reports",
      format: "md", content: "# a", by: "lucas", spaceId: spaceA,
    });
    const share = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!share.ok) throw new Error("create failed");
    await clearSpaceId(share.id);

    const r = await backfillShareSpaceIds();
    expect(r.dirFilled).toBe(1);
    expect(r.dirRevoked).toBe(0);
    const [row] = await db
      .select({ spaceId: shares.spaceId, revokedAt: shares.revokedAt })
      .from(shares).where(eq(shares.id, share.id));
    expect(row.spaceId).toBe(spaceA);
    expect(row.revokedAt).toBeNull();
  });

  it("directory share matching MORE THAN ONE space → revoked (fail-closed), space_id left null", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    const spaceB = await seedSpace({ slug: "space-b", ownerId: owner });
    await publishDocOk({
      slug: "a-report", title: "A", sourcePath: "reports/x.md", path: "reports",
      format: "md", content: "# a", by: "lucas", spaceId: spaceA,
    });
    await publishDocOk({
      slug: "b-report", title: "B", sourcePath: "reports/x.md", path: "reports",
      format: "md", content: "# b", by: "lucas", spaceId: spaceB,
    });
    const share = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!share.ok) throw new Error("create failed");
    await clearSpaceId(share.id);

    const r = await backfillShareSpaceIds();
    expect(r.dirRevoked).toBe(1);
    const [row] = await db
      .select({ spaceId: shares.spaceId, revokedAt: shares.revokedAt })
      .from(shares).where(eq(shares.id, share.id));
    expect(row.spaceId).toBeNull();
    expect(row.revokedAt).not.toBeNull();
    // A revoked share is dead everywhere.
    expect(await resolveDirectoryShare(share.token)).toBeNull();
  });

  it("directory share matching ZERO spaces (empty folder) → revoked (fail-closed)", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    // Publish an unrelated doc so the space exists but nothing matches the prefix.
    await publishDocOk({
      slug: "misc", title: "Misc", sourcePath: "misc.md", path: "misc",
      format: "md", content: "# misc", by: "lucas", spaceId: spaceA,
    });
    const share = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!share.ok) throw new Error("create failed");
    await clearSpaceId(share.id);

    const r = await backfillShareSpaceIds();
    expect(r.dirRevoked).toBe(1);
    const [row] = await db
      .select({ spaceId: shares.spaceId, revokedAt: shares.revokedAt })
      .from(shares).where(eq(shares.id, share.id));
    expect(row.spaceId).toBeNull();
    expect(row.revokedAt).not.toBeNull();
  });

  it("unpublished docs are ignored when resolving the owning space", async () => {
    const owner = await seedUser({ email: "o@test.local", displayName: "O", role: "admin" });
    const spaceA = await seedSpace({ slug: "space-a", ownerId: owner });
    const spaceB = await seedSpace({ slug: "space-b", ownerId: owner });
    await publishDocOk({
      slug: "a-report", title: "A", sourcePath: "reports/x.md", path: "reports",
      format: "md", content: "# a", by: "lucas", spaceId: spaceA,
    });
    // Space B has a matching doc too, but it is unpublished → not counted.
    await publishDocOk({
      slug: "b-report", title: "B", sourcePath: "reports/x.md", path: "reports",
      format: "md", content: "# b", by: "lucas", spaceId: spaceB,
    });
    const { unpublishDoc } = await import("@/lib/docs");
    await unpublishDoc("b-report");

    const share = await createDirectoryShare("space-a", "reports", "Reports", "lucas");
    if (!share.ok) throw new Error("create failed");
    await clearSpaceId(share.id);

    const r = await backfillShareSpaceIds();
    // Only space A has a PUBLISHED matching doc → unambiguous.
    expect(r.dirFilled).toBe(1);
    const [row] = await db.select({ spaceId: shares.spaceId }).from(shares).where(eq(shares.id, share.id));
    expect(row.spaceId).toBe(spaceA);
  });
});
