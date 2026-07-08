/**
 * Owner-namespace S4 — legacy single-slug URL resolution (`planSpaceRoute`, the
 * logic the proxy applies). Two owners (alice, bob) both hold `reports`; alice
 * also holds a unique `solo` and a space literally named `docs` (a reserved
 * sub-resource word, to prove the reserved-word disambiguation).
 *
 *   - WEB  /spaces/<unique-slug>   → 301 redirect to /spaces/<handle>/<slug>
 *   - WEB  /spaces/<ambiguous>     → pass (Next renders 404; no arbitrary owner)
 *   - WEB  canonical /spaces/a/b   → pass
 *   - API  /api/spaces/<unique>/…  → rewrite IN PLACE to /api/spaces/<handle>/…
 *   - API  /api/spaces/<ambiguous>/… → 409 conflict
 *   - API  canonical /api/spaces/<handle>/<slug>/… → pass
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { createSpace } from "@/lib/spaces";
import { planSpaceRoute } from "@/lib/legacy-space-route";

async function seedAdmin(tokenName: string): Promise<number> {
  const [u] = await db
    .insert(schema.users)
    .values({ tokenName, displayName: tokenName, role: "admin", active: 1 })
    .returning({ id: schema.users.id });
  return u.id;
}

describe("planSpaceRoute — legacy single-slug URL resolution (S4)", () => {
  beforeEach(async () => {
    await resetDb();
    const alice = await seedAdmin("alice");
    const bob = await seedAdmin("bob");
    const a = await createSpace("reports", alice, "private", "t"); // shared slug
    const b = await createSpace("reports", bob, "private", "t"); // shared slug
    const s = await createSpace("solo", alice, "private", "t"); // unique to alice
    const d = await createSpace("docs", alice, "private", "t"); // slug == reserved word
    if (!a.ok || !b.ok || !s.ok || !d.ok) throw new Error("setup failed");
  });

  // ── WEB ──────────────────────────────────────────────────────────────────
  it("web: /spaces/<unique-slug> → 301 redirect to the owner-qualified URL", async () => {
    const plan = await planSpaceRoute("/spaces/solo");
    expect(plan).toEqual({ kind: "redirect", location: "/spaces/alice/solo" });
  });

  it("web: /spaces/<ambiguous-slug> → pass (natural 404; no arbitrary owner)", async () => {
    expect(await planSpaceRoute("/spaces/reports")).toEqual({ kind: "pass" });
  });

  it("web: /spaces/<unknown-slug> → pass (natural 404)", async () => {
    expect(await planSpaceRoute("/spaces/ghost")).toEqual({ kind: "pass" });
  });

  it("web: canonical /spaces/<owner>/<slug> and the /spaces list → pass (no DB rewrite)", async () => {
    expect(await planSpaceRoute("/spaces/alice/reports")).toEqual({ kind: "pass" });
    expect(await planSpaceRoute("/spaces")).toEqual({ kind: "pass" });
  });

  // ── API ──────────────────────────────────────────────────────────────────
  it("api: /api/spaces/<unique-slug> (root) → rewrite in place to owner-qualified", async () => {
    expect(await planSpaceRoute("/api/spaces/solo")).toEqual({
      kind: "rewrite",
      pathname: "/api/spaces/alice/solo",
    });
  });

  it("api: /api/spaces/<unique-slug>/<subresource> → rewrite in place (preserves the sub-path)", async () => {
    expect(await planSpaceRoute("/api/spaces/solo/docs")).toEqual({
      kind: "rewrite",
      pathname: "/api/spaces/alice/solo/docs",
    });
    expect(await planSpaceRoute("/api/spaces/solo/raw/a/b.png")).toEqual({
      kind: "rewrite",
      pathname: "/api/spaces/alice/solo/raw/a/b.png",
    });
  });

  it("api: /api/spaces/<ambiguous-slug>[/…] → 409 conflict", async () => {
    expect(await planSpaceRoute("/api/spaces/reports")).toEqual({ kind: "conflict" });
    expect(await planSpaceRoute("/api/spaces/reports/members")).toEqual({ kind: "conflict" });
  });

  it("api: canonical /api/spaces/<handle>/<slug>[/…] → pass (handle recognized)", async () => {
    expect(await planSpaceRoute("/api/spaces/alice/reports")).toEqual({ kind: "pass" });
    expect(await planSpaceRoute("/api/spaces/alice/reports/docs")).toEqual({ kind: "pass" });
    // A non-reserved 2nd segment is structurally canonical — no DB, straight pass.
    expect(await planSpaceRoute("/api/spaces/whoever/anything")).toEqual({ kind: "pass" });
  });

  it("api: /api/spaces (collection) and unknown slug → pass", async () => {
    expect(await planSpaceRoute("/api/spaces/")).toEqual({ kind: "pass" });
    expect(await planSpaceRoute("/api/spaces/ghost")).toEqual({ kind: "pass" });
  });

  // ── reserved-word disambiguation ───────────────────────────────────────────
  it("api: a space literally named `docs` resolves at its CANONICAL root (handle wins)", async () => {
    // /api/spaces/alice/docs — `alice` is a handle → canonical → pass (not mistaken
    // for legacy `<slug=alice>/<subresource=docs>`).
    expect(await planSpaceRoute("/api/spaces/alice/docs")).toEqual({ kind: "pass" });
  });

  it("api: the LEGACY form of a reserved-word slug still rewrites (`/api/spaces/docs/members`)", async () => {
    // `docs` is not a handle → legacy → resolve slug `docs` (alice owns it) →
    // rewrite to /api/spaces/alice/docs/members.
    expect(await planSpaceRoute("/api/spaces/docs/members")).toEqual({
      kind: "rewrite",
      pathname: "/api/spaces/alice/docs/members",
    });
  });
});
