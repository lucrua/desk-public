import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
import { resolvePrincipalUserId } from "@/lib/principal-user";
import {
  searchDocs,
  unpublishDoc,
  publishDoc,
  SNIPPET_START,
  SNIPPET_STOP,
  type PublishInput,
} from "./docs";

const base: PublishInput = {
  slug: "alpha",
  title: "Alpha",
  sourcePath: "os/alpha.md",
  format: "md",
  content: "# Alpha\nbody text",
  by: "lucas",
};

const admin = { viewer: "admin" as const };
// Gen-2: member visibility is SPACE-scoped. `member.userId` is the dev member's
// resolved id (filled in setup) — a reader of the default `workspace` space, so
// member-scoped search sees workspace docs but not docs in spaces it isn't in.
let member: { viewer: "member"; userId: number };

describe("searchDocs — full-text search service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedDevMemberInDefaultSpace();
    const memberId = await resolvePrincipalUserId({ kind: "member", name: "Dev Member" });
    member = { viewer: "member", userId: memberId! };
  });

  it("empty / whitespace query returns []", async () => {
    await publishDocOk(base);
    expect(await searchDocs("", { scope: admin })).toEqual([]);
    expect(await searchDocs("   ", { scope: admin })).toEqual([]);
  });

  it("matches on title", async () => {
    await publishDocOk({ ...base, slug: "rocket", title: "Rocket Science", content: "no match here" });
    const out = await searchDocs("rocket", { scope: admin });
    expect(out.map((d) => d.slug)).toContain("rocket");
  });

  it("matches on current-version content", async () => {
    await publishDocOk({ ...base, slug: "bodydoc", title: "Title Z", content: "the quantum widget hums" });
    const out = await searchDocs("quantum", { scope: admin });
    expect(out.map((d) => d.slug)).toContain("bodydoc");
  });

  it("ranking: a title match outranks a body-only match", async () => {
    // Doc A: term in the TITLE (weight A). Doc B: same term only in BODY (weight B).
    await publishDocOk({
      slug: "title-hit",
      title: "Mercury Report",
      sourcePath: "x.md",
      format: "md",
      content: "unrelated body content",
      by: "lucas",
    });
    await publishDocOk({
      slug: "body-hit",
      title: "Unrelated Heading",
      sourcePath: "y.md",
      format: "md",
      content: "a long passage that mentions mercury once in the body only",
      by: "lucas",
    });
    const out = await searchDocs("mercury", { scope: admin });
    const slugs = out.map((d) => d.slug);
    expect(slugs).toContain("title-hit");
    expect(slugs).toContain("body-hit");
    // Title match ranks first.
    expect(slugs.indexOf("title-hit")).toBeLessThan(slugs.indexOf("body-hit"));
    // And the rank value reflects it.
    const titleRow = out.find((d) => d.slug === "title-hit")!;
    const bodyRow = out.find((d) => d.slug === "body-hit")!;
    expect(titleRow.rank).toBeGreaterThan(bodyRow.rank);
  });

  it("returns a delimiter-encoded snippet around the match (never raw <b>)", async () => {
    await publishDocOk({
      ...base,
      slug: "snip",
      title: "Snip",
      content: "intro words then the keyword zenith appears mid sentence and more after",
    });
    const [row] = await searchDocs("zenith", { scope: admin });
    expect(row).toBeTruthy();
    expect(row.snippet).toContain(SNIPPET_START);
    expect(row.snippet).toContain(SNIPPET_STOP);
    // The default ts_headline <b>…</b> markup must NOT appear.
    expect(row.snippet).not.toContain("<b>");
    expect(row.snippet).not.toContain("</b>");
  });

  // ── member scoping ──────────────────────────────────────────────────────────

  it("member: a doc in a space they're not in is absent from results", async () => {
    // `secret` lives in a SEPARATE private space the dev member is NOT in.
    const adminId = await seedUser({ email: "search-admin@test.com", displayName: "Admin", role: "admin" });
    const hiddenSpace = await seedSpace({ slug: "priv", ownerId: adminId, visibility: "private" });
    await publishDocOk({
      slug: "secret",
      title: "Secret Mercury",
      sourcePath: "s.md",
      format: "md",
      content: "mercury content",
      by: "lucas",
      spaceId: hiddenSpace,
    });
    // `shown` lands in the default `workspace` space the dev member reads.
    await publishDocOk({
      slug: "shown",
      title: "Public Mercury",
      sourcePath: "p.md",
      format: "md",
      content: "mercury content",
      by: "lucas",
    });
    const adminSlugs = (await searchDocs("mercury", { scope: admin })).map((d) => d.slug);
    expect(adminSlugs).toContain("secret");
    expect(adminSlugs).toContain("shown");

    const memberSlugs = (await searchDocs("mercury", { scope: member })).map((d) => d.slug);
    expect(memberSlugs).toContain("shown");
    expect(memberSlugs).not.toContain("secret");
  });

  // ── unpublished handling (mirrors listDocs) ────────────────────────────────

  it("unpublished doc: hidden for non-admin (no includeUnpublished), shown for admin", async () => {
    await publishDocOk({ ...base, slug: "gone", title: "Gone Mercury", content: "mercury here" });
    await unpublishDoc("gone");

    // Member (no includeUnpublished) never sees it.
    const memberSlugs = (await searchDocs("mercury", { scope: member })).map((d) => d.slug);
    expect(memberSlugs).not.toContain("gone");

    // Admin with includeUnpublished sees it.
    const adminSlugs = (
      await searchDocs("mercury", { includeUnpublished: true, scope: admin })
    ).map((d) => d.slug);
    expect(adminSlugs).toContain("gone");

    // Admin WITHOUT includeUnpublished filters it out (mirrors listDocs).
    const adminNoUnpub = (await searchDocs("mercury", { scope: admin })).map((d) => d.slug);
    expect(adminNoUnpub).not.toContain("gone");
  });

  // ── search_tsv maintenance ─────────────────────────────────────────────────

  it("re-publish with new content makes the new term searchable (old term gone)", async () => {
    await publishDocOk({ ...base, slug: "evolve", title: "Evolve", content: "originalterm body" });
    expect((await searchDocs("originalterm", { scope: admin })).map((d) => d.slug)).toContain("evolve");

    await publishDocOk({ ...base, slug: "evolve", title: "Evolve", content: "replacedterm body" });
    expect((await searchDocs("replacedterm", { scope: admin })).map((d) => d.slug)).toContain("evolve");
    // The old term no longer matches (current-version only).
    expect((await searchDocs("originalterm", { scope: admin })).map((d) => d.slug)).not.toContain("evolve");
  });

  it("title-only change (same content) refreshes the title vector", async () => {
    await publishDocOk({ ...base, slug: "retitle", title: "First Title", content: "stable body" });
    // Same content, new title — the no-op-content branch still refreshes search_tsv.
    await publishDoc({ ...base, slug: "retitle", title: "Renamed Beacon", content: "stable body" });
    const slugs = (await searchDocs("beacon", { scope: admin })).map((d) => d.slug);
    expect(slugs).toContain("retitle");
  });

  // ── XSS: doc body with an injection payload near the match ──────────────────

  it("XSS: snippet from a body containing <img onerror=…> carries the markup as data, not as ts_headline HTML", async () => {
    await publishDocOk({
      ...base,
      slug: "xss",
      title: "Xss",
      content: `before the marker <img src=x onerror=alert(1)> targetword after the payload`,
    });
    const [row] = await searchDocs("targetword", { scope: admin });
    expect(row).toBeTruthy();
    // The ONLY markup-producing sink (ts_headline default <b>) must be absent:
    // our custom delimiters are control chars, so no `<b>`/`</b>` appears.
    expect(row.snippet).not.toContain("<b>");
    expect(row.snippet).not.toContain("</b>");
    // The match is wrapped in our control-char delimiters, never in `<…>`.
    expect(row.snippet).toContain(`${SNIPPET_START}targetword${SNIPPET_STOP}`);
  });
});
