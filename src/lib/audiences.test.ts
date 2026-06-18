import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences } from "@/test/db";
import { publishDoc } from "./docs";
import {
  listAudiences,
  createAudience,
  setAudienceMemberVisible,
  deleteAudience,
  audienceExists,
} from "./audiences";

const doc = (slug: string, audience: string) => ({
  slug,
  title: slug,
  sourcePath: `os/${slug}.md`,
  audience,
  format: "md" as const,
  content: `# ${slug}`,
  by: "admin",
});

describe("audiences service", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  describe("listAudiences", () => {
    it("returns the seeded canon (private default + team visible, alice/bob hidden), id-ordered", async () => {
      const list = await listAudiences();
      expect(list.map((a) => a.key)).toEqual(["private", "team", "alice", "bob"]);
      expect(list[0]).toMatchObject({ key: "private", label: "Private", memberVisible: false });
      expect(list[1]).toMatchObject({ key: "team", label: "Team", memberVisible: true });
      expect(list[2]).toMatchObject({ key: "alice", memberVisible: false });
    });

    it("includes a live doc-count per audience key", async () => {
      await publishDoc(doc("a", "team"));
      await publishDoc(doc("b", "team"));
      await publishDoc(doc("c", "alice"));

      const list = await listAudiences();
      const byKey = Object.fromEntries(list.map((a) => [a.key, a.docCount]));
      expect(byKey.team).toBe(2);
      expect(byKey.alice).toBe(1);
      expect(byKey.bob).toBe(0);
    });
  });

  describe("createAudience", () => {
    it("creates a new audience and returns it (docCount 0)", async () => {
      const a = await createAudience({ key: "acme", label: "Acme", memberVisible: false });
      expect(a).not.toBeNull();
      expect(a!.key).toBe("acme");
      expect(a!.label).toBe("Acme");
      expect(a!.memberVisible).toBe(false);
      expect(a!.docCount).toBe(0);
      expect(await audienceExists("acme")).toBe(true);
    });

    it("trims the label", async () => {
      const a = await createAudience({ key: "x", label: "  Padded  ", memberVisible: false });
      expect(a!.label).toBe("Padded");
    });

    it("returns null for a duplicate key", async () => {
      expect(await createAudience({ key: "team", label: "Dup", memberVisible: false })).toBeNull();
    });

    it("returns null for an invalid key", async () => {
      expect(await createAudience({ key: "Bad Key", label: "X", memberVisible: false })).toBeNull();
      expect(await createAudience({ key: "-leading", label: "X", memberVisible: false })).toBeNull();
      expect(await createAudience({ key: "with:colon", label: "X", memberVisible: false })).toBeNull();
    });

    it("returns null for an empty label", async () => {
      expect(await createAudience({ key: "ok-key", label: "   ", memberVisible: false })).toBeNull();
    });
  });

  describe("audienceExists", () => {
    it("true for a seeded key, false for an unknown key", async () => {
      expect(await audienceExists("team")).toBe(true);
      expect(await audienceExists("nope")).toBe(false);
    });
  });

  describe("setAudienceMemberVisible", () => {
    it("flips member-visibility and persists", async () => {
      const [alice] = (await listAudiences()).filter((a) => a.key === "alice");
      expect(await setAudienceMemberVisible(alice.id, true)).toBe(true);
      const after = (await listAudiences()).find((a) => a.key === "alice");
      expect(after!.memberVisible).toBe(true);
    });

    it("returns false for an unknown id", async () => {
      expect(await setAudienceMemberVisible(99999, true)).toBe(false);
    });
  });

  describe("deleteAudience", () => {
    it("deletes an unused audience → ok", async () => {
      const a = await createAudience({ key: "spare", label: "Spare", memberVisible: false });
      expect(await deleteAudience(a!.id)).toBe("ok");
      expect(await audienceExists("spare")).toBe(false);
    });

    it("refuses to delete an in-use audience → in-use", async () => {
      const a = await createAudience({ key: "used", label: "Used", memberVisible: false });
      await publishDoc(doc("d", "used"));
      expect(await deleteAudience(a!.id)).toBe("in-use");
      expect(await audienceExists("used")).toBe(true);
    });

    it("returns not-found for an unknown id", async () => {
      expect(await deleteAudience(99999)).toBe("not-found");
    });
  });
});
