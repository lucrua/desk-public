import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk, createShareOk } from "@/test/db";
import { createShare, resolveShare, listSharesForDoc } from "./shares";
import { unpublishDoc } from "@/lib/docs";

const DOC = {
  slug: "pin-doc",
  title: "Pin",
  sourcePath: "os/pin.md",
  audience: "team",
  format: "md" as const,
  content: "# v1",
  by: "lucas",
};

const OTHER = { ...DOC, slug: "other-doc", content: "# other" };

describe("pinned shares", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("a pinned share resolves the pinned version even after the doc advances", async () => {
    const v1 = await publishDocOk(DOC);
    const share = await createShareOk("pin-doc", "Pinned to v1", "lucas", undefined, v1.versionId);

    // Advance the doc to v2.
    await publishDocOk({ ...DOC, content: "# v2" });

    const resolved = await resolveShare(share.token);
    expect(resolved).not.toBeNull();
    expect(resolved!.pinned).toBe(true);
    expect(resolved!.version!.id).toBe(v1.versionId);
    expect(resolved!.version!.content).toBe("# v1"); // NOT v2
  });

  it("a live (unpinned) share follows the current version", async () => {
    await publishDocOk(DOC);
    const share = await createShareOk("pin-doc", "Live", "lucas");
    await publishDocOk({ ...DOC, content: "# v2" });

    const resolved = await resolveShare(share.token);
    expect(resolved!.pinned).toBe(false);
    expect(resolved!.version!.content).toBe("# v2");
  });

  it("a pinned share of an UNPUBLISHED doc still 404s (unpublish kills links)", async () => {
    const v1 = await publishDocOk(DOC);
    const share = await createShareOk("pin-doc", "Pinned", "lucas", undefined, v1.versionId);
    await unpublishDoc("pin-doc");

    const resolved = await resolveShare(share.token);
    expect(resolved).toBeNull();
  });

  it("createShare with a pinned version from a DIFFERENT doc → error (no cross-doc leak)", async () => {
    await publishDocOk(DOC);
    const otherV = await publishDocOk(OTHER);

    const out = await createShare("pin-doc", "Bad pin", "lucas", undefined, otherV.versionId);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("pinned-version-not-found");
  });

  it("createShare with a non-existent version id → error", async () => {
    await publishDocOk(DOC);
    const out = await createShare("pin-doc", "Bad pin", "lucas", undefined, 99999);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("pinned-version-not-found");
  });

  it("listSharesForDoc surfaces pinnedVersionId (for the per-doc panel chip)", async () => {
    const v1 = await publishDocOk(DOC);
    await createShareOk("pin-doc", "Pinned", "lucas", undefined, v1.versionId);
    await createShareOk("pin-doc", "Live", "lucas");

    const rows = await listSharesForDoc("pin-doc");
    const pinned = rows.find((r) => r.label === "Pinned");
    const live = rows.find((r) => r.label === "Live");
    expect(pinned!.pinnedVersionId).toBe(v1.versionId);
    expect(live!.pinnedVersionId).toBeNull();
  });
});
