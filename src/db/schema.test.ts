import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { docs, docVersions, accessRequests } from "@/db/schema";
import { eq } from "drizzle-orm";
import { resetDb, seedDefaultSpace } from "@/test/db";

describe("schema smoke test — docs + doc_versions round-trip", () => {
  let spaceId: number;
  beforeEach(async () => {
    await resetDb();
    spaceId = await seedDefaultSpace();
  });

  it("inserts a doc + version, updates currentVersionId, reads back with correct defaults", async () => {
    // Insert a doc
    const [doc] = await db
      .insert(docs)
      .values({
        slug: "test-doc-001",
        title: "Test Document",
        sourcePath: "os/CONTEXT.md",
        audience: "team",
        spaceId,
        // format defaults to "md", unpublishedAt defaults to null
      })
      .returning();

    expect(doc.slug).toBe("test-doc-001");
    expect(doc.format).toBe("md");
    expect(doc.unpublishedAt).toBeNull();
    expect(doc.currentVersionId).toBeNull();
    expect(doc.id).toBeTypeOf("number");

    // Insert a version for the doc
    const contentStr = "# Hello\nThis is the content.";
    const hashStr = "abc123def456"; // placeholder sha256 hex
    const [version] = await db
      .insert(docVersions)
      .values({
        docId: doc.id,
        content: contentStr,
        contentHash: hashStr,
        publishedBy: "lucas",
      })
      .returning();

    expect(version.docId).toBe(doc.id);
    expect(version.content).toBe(contentStr);
    expect(version.contentHash).toBe(hashStr);
    expect(version.publishedBy).toBe("lucas");
    expect(version.publishedAt).toBeInstanceOf(Date);

    // Update doc.currentVersionId to point to the new version
    const [updatedDoc] = await db
      .update(docs)
      .set({ currentVersionId: version.id })
      .where(eq(docs.id, doc.id))
      .returning();

    expect(updatedDoc.currentVersionId).toBe(version.id);

    // Read back the doc and verify all fields round-trip
    const [fetched] = await db
      .select()
      .from(docs)
      .where(eq(docs.id, doc.id));

    expect(fetched.slug).toBe("test-doc-001");
    expect(fetched.title).toBe("Test Document");
    expect(fetched.sourcePath).toBe("os/CONTEXT.md");
    expect(fetched.audience).toBe("team");
    expect(fetched.format).toBe("md");
    expect(fetched.currentVersionId).toBe(version.id);
    expect(fetched.unpublishedAt).toBeNull();
    expect(fetched.createdAt).toBeInstanceOf(Date);
  });

  it("enforces unique slug constraint", async () => {
    await db.insert(docs).values({
      slug: "duplicate-slug",
      title: "First",
      sourcePath: "os/A.md",
      audience: "team",
      spaceId,
    });

    let thrown: unknown;
    try {
      await db.insert(docs).values({
        slug: "duplicate-slug",
        title: "Second",
        sourcePath: "os/B.md",
        audience: "team",
        spaceId,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    // DrizzleQueryError wraps the PG error on .cause; check the cause message
    // for the actual unique-violation detail.
    const causeMsg = (thrown as { cause?: { message?: string } })?.cause?.message ?? String(thrown);
    expect(causeMsg).toMatch(/duplicate key|unique/i);
  });
});

describe("schema smoke test — access_requests", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("inserts with defaults (hits=1, timestamps set)", async () => {
    const [row] = await db
      .insert(accessRequests)
      .values({ email: "visitor@example.com" })
      .returning();
    expect(row.email).toBe("visitor@example.com");
    expect(row.hits).toBe(1);
    expect(row.firstSeenAt).toBeInstanceOf(Date);
    expect(row.lastSeenAt).toBeInstanceOf(Date);
    expect(row.id).toBeTypeOf("number");
  });

  it("enforces unique email constraint", async () => {
    await db.insert(accessRequests).values({ email: "dup@example.com" });
    let thrown: unknown;
    try {
      await db.insert(accessRequests).values({ email: "dup@example.com" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const causeMsg = (thrown as { cause?: { message?: string } })?.cause?.message ?? String(thrown);
    expect(causeMsg).toMatch(/duplicate key|unique/i);
  });
});
