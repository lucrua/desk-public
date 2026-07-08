/**
 * Regression: `listProposalsForSpace` on a space whose bare repo has not been
 * created yet (created in the DB but never pushed). The proposals git plumbing
 * spawns `git for-each-ref` with `cwd` = the repo path; a non-existent cwd makes
 * Node throw `spawn git ENOENT`, which previously crashed the space detail page
 * (the page calls this on render). The guard must return an empty list instead.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb } from "@/test/db";
import { db, schema } from "@/db";
import { createSpace } from "@/lib/spaces";
import { listProposalsForSpace } from "@/lib/proposals-service";

describe("listProposalsForSpace — never-pushed space (no bare repo)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns an empty proposal list without crashing when the repo does not exist", async () => {
    const owner = (
      await db
        .insert(schema.users)
        .values({ tokenName: "owner", displayName: "Owner", role: "admin", active: 1 })
        .returning()
    )[0];
    const created = await createSpace("fresh", owner.id, "private", "t");
    if (!created.ok) throw new Error("setup");

    // No push has happened → the bare repo is absent on disk. This must NOT
    // throw `spawn git ENOENT`.
    const res = await listProposalsForSpace(created.space.id);
    expect(res).toEqual({ ok: true, proposals: [] });
  });

  it("still reports unknown-space when the space id has no row", async () => {
    const res = await listProposalsForSpace(-1);
    expect(res).toEqual({ ok: false, reason: "unknown-space" });
  });
});
