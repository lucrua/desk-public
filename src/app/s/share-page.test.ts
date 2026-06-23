import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, createShareOk, publishDocOk } from "@/test/db";
import { unpublishDoc } from "@/lib/docs";
import { revokeShare } from "@/lib/shares";
import { loadShareView, formatStamp, excerptFrom } from "./[token]/load-share";

const BASE_DOC = {
  slug: "market-context",
  title: "Market context",
  sourcePath: "os/market.md",
  audience: "external:pedro",
  format: "md" as const,
  content: "# Market context\n\nThe short version: consolidation worked.",
  by: "lucas",
};

// Read share_views rows for a share id.
async function viewRows(shareId: number) {
  const { db } = await import("@/db");
  const { shareViews } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  return db.select().from(shareViews).where(eq(shareViews.shareId, shareId));
}

// Insert a share with an explicit expiresAt (past or future) directly.
async function seedShareWithExpiry(docSlug: string, expiresAt: Date) {
  const { db } = await import("@/db");
  const { shares, docs } = await import("@/db/schema");
  const { eq } = await import("drizzle-orm");
  const { mintToken, hashToken } = await import("@/lib/tokens");
  const docRows = await db.select().from(docs).where(eq(docs.slug, docSlug));
  const token = mintToken();
  const [row] = await db
    .insert(shares)
    .values({
      tokenHash: hashToken(token),
      docId: docRows[0].id,
      label: "expiry-test",
      createdBy: "lucas",
      expiresAt,
    })
    .returning();
  return { token, id: row.id };
}

describe("loadShareView", () => {
  beforeEach(async () => {
    await resetDb();
    await publishDocOk(BASE_DOC);
  });

  describe("formatStamp", () => {
    it('formats as "9 Jun 2026"', () => {
      expect(formatStamp(new Date(Date.UTC(2026, 5, 9)))).toBe("9 Jun 2026");
      expect(formatStamp(new Date(Date.UTC(2026, 0, 1)))).toBe("1 Jan 2026");
      expect(formatStamp(new Date(Date.UTC(2026, 11, 23)))).toBe("23 Dec 2026");
    });
  });

  describe("valid share", () => {
    it("returns the md view model + writes a view row", async () => {
      // Pass null for expiresInDays so the share never expires (expiresSoon false).
      const share = await createShareOk("market-context", "Pedro", "lucas", null);
      const view = await loadShareView(share!.token, {
        ip: "1.2.3.4",
        userAgent: "Mozilla/5.0",
      });

      expect(view).not.toBeNull();
      expect(view!.kind).toBe("md");
      expect(view!.title).toBe("Market context");
      expect(view!.content).toBe(BASE_DOC.content);
      expect(view!.createdBy).toBe("lucas");
      expect(view!.expiresSoon).toBe(false);
      expect(view!.expiresStamp).toBeNull();

      const rows = await viewRows(share!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].ip).toBe("1.2.3.4");
      expect(rows[0].userAgent).toBe("Mozilla/5.0");
    });

    it("writes a view row on EVERY render (two loads → two rows)", async () => {
      const share = await createShareOk("market-context", "Pedro", "lucas", null);
      await loadShareView(share!.token);
      await loadShareView(share!.token);
      const rows = await viewRows(share!.id);
      expect(rows).toHaveLength(2);
    });

    it("returns kind:html for an html-format doc", async () => {
      await publishDocOk({
        ...BASE_DOC,
        slug: "html-doc",
        format: "html",
        content: "<h1>hi</h1>",
      });
      const share = await createShareOk("html-doc", "Pedro", "lucas", null);
      const view = await loadShareView(share!.token);
      expect(view!.kind).toBe("html");
      expect(view!.content).toBe("<h1>hi</h1>");
    });
  });

  describe("recordView caps long ip/ua (enforced in recordView, observed in db)", () => {
    it("truncates ip to 64 and ua to 512 chars", async () => {
      const share = await createShareOk("market-context", "Pedro", "lucas", null);
      await loadShareView(share!.token, {
        ip: "9".repeat(300),
        userAgent: "A".repeat(2000),
      });
      const rows = await viewRows(share!.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].ip).toHaveLength(64);
      expect(rows[0].userAgent).toHaveLength(512);
    });
  });

  describe("null paths (uniform 404) — no view row written", () => {
    it("unknown token → null", async () => {
      const view = await loadShareView("Z".repeat(43));
      expect(view).toBeNull();
    });

    it("revoked share → null, no view row", async () => {
      const share = await createShareOk("market-context", "Pedro", "lucas");
      await revokeShare(share!.id);
      const view = await loadShareView(share!.token);
      expect(view).toBeNull();
      const rows = await viewRows(share!.id);
      expect(rows).toHaveLength(0);
    });

    it("expired share → null", async () => {
      const { token } = await seedShareWithExpiry(
        "market-context",
        new Date(Date.now() - 60 * 60 * 1000),
      );
      const view = await loadShareView(token);
      expect(view).toBeNull();
    });

    it("unpublished doc → null", async () => {
      const share = await createShareOk("market-context", "Pedro", "lucas");
      await unpublishDoc("market-context");
      const view = await loadShareView(share!.token);
      expect(view).toBeNull();
    });
  });

  describe("excerptFrom — OG description helper", () => {
    it("strips markdown headings and returns plain text", () => {
      const result = excerptFrom("# My Title\n\nSome body text here.");
      expect(result).not.toContain("#");
      expect(result).toContain("My Title");
      expect(result).toContain("Some body text here.");
    });

    it("strips HTML tags", () => {
      const result = excerptFrom("<h1>Title</h1><p>Body content.</p>");
      expect(result).not.toContain("<");
      expect(result).toContain("Title");
      expect(result).toContain("Body content.");
    });

    it("truncates at 160 chars with ellipsis", () => {
      const long = "word ".repeat(40); // 200 chars
      const result = excerptFrom(long);
      expect(result.length).toBeLessThanOrEqual(164); // 160 + "…"
      expect(result.endsWith("…")).toBe(true);
    });

    it("returns content as-is when under maxLen", () => {
      const short = "Just a short sentence.";
      const result = excerptFrom(short);
      expect(result).toBe("Just a short sentence.");
    });

    it("strips fenced code blocks", () => {
      const result = excerptFrom("Intro.\n\n```js\nconsole.log('hi');\n```\n\nOutro.");
      expect(result).not.toContain("console.log");
      expect(result).toContain("Intro.");
      expect(result).toContain("Outro.");
    });

    it("returns empty string for empty content", () => {
      expect(excerptFrom("")).toBe("");
    });
  });

  describe("expiresSoon boundary (window = 7 days)", () => {
    // Use a far-future fixed "now" so expiresAt values are always in the future
    // from the real clock's perspective (avoiding flaky tests as real time passes).
    const now = new Date(Date.UTC(2030, 0, 1, 12, 0, 0)); // 2030-01-01

    it("6 days away → true", async () => {
      const expiresAt = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
      const { token } = await seedShareWithExpiry("market-context", expiresAt);
      const view = await loadShareView(token, { now });
      expect(view).not.toBeNull();
      expect(view!.expiresSoon).toBe(true);
      expect(view!.expiresStamp).toBe(formatStamp(expiresAt));
    });

    it("8 days away → false", async () => {
      const expiresAt = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
      const { token } = await seedShareWithExpiry("market-context", expiresAt);
      const view = await loadShareView(token, { now });
      expect(view).not.toBeNull();
      expect(view!.expiresSoon).toBe(false);
    });
  });
});
