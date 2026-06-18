import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { decideFile, decideDirAdoptions } from "./sync-core.mjs";
import { merge3 } from "./diff3.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const merge = (a, b, c) => merge3(a, b, c);

/** Build a remoteDoc whose contentHash is derived from content (realistic). */
function remote(versionId, content) {
  return {
    currentVersionId: versionId,
    content,
    contentHash: content === null ? null : hash(content),
    format: "md",
  };
}

/** A throwing fetchBase to assert it is NOT called on non-merge paths. */
const noFetch = async () => {
  throw new Error("fetchBase should not be called");
};

describe("decideFile — single-axis branches", () => {
  it("neither changed → noop", async () => {
    const content = "a\nb\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(content) };
    const d = await decideFile({ entry, localContent: content, remoteDoc: remote(5, content), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("noop");
  });

  it("local only → push with base_version_id", async () => {
    const base = "a\nb\n";
    const local = "a\nB\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(5, base), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("push");
    expect(d.content).toBe(local);
    expect(d.baseVersionId).toBe(5);
    expect(d.nextStateOnPush).toBe(true);
  });

  it("remote only → pull, state advances to cloud HEAD", async () => {
    const base = "a\nb\n";
    const cloud = "a\nb\nc\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const d = await decideFile({ entry, localContent: base, remoteDoc: remote(7, cloud), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("pull");
    expect(d.content).toBe(cloud);
    expect(d.nextState).toEqual({ lastSyncedVersionId: 7, lastSyncedHash: hash(cloud) });
  });

  it("local equals cloud HEAD but state stale → noop that converges state", async () => {
    const content = "same\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 4, lastSyncedHash: hash("old\n") };
    const d = await decideFile({ entry, localContent: content, remoteDoc: remote(9, content), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("noop");
    expect(d.nextState).toEqual({ lastSyncedVersionId: 9, lastSyncedHash: hash(content) });
  });
});

describe("decideFile — both changed (merge paths)", () => {
  it("both changed, clean merge → merge-push, base = cloud HEAD", async () => {
    const base = "l1\nl2\nl3\nl4\n";
    const local = "L1\nl2\nl3\nl4\n";
    const cloud = "l1\nl2\nl3\nL4\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const fetchBase = async (id) => (id === 5 ? base : null);
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(8, cloud), fetchBase, merge, hash });
    expect(d.action).toBe("merge-push");
    expect(d.content).toBe("L1\nl2\nl3\nL4\n");
    expect(d.baseVersionId).toBe(8); // base-check against cloud HEAD
  });

  it("both changed, dirty merge → revision (note + pullAfter), state = cloud HEAD", async () => {
    const base = "a\nb\nc\n";
    const local = "a\nOURS\nc\n";
    const cloud = "a\nTHEIRS\nc\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const fetchBase = async () => base;
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(8, cloud), fetchBase, merge, hash, hostname: "machine-a" });
    expect(d.action).toBe("revision");
    expect(d.content).toBe(local);
    expect(d.note).toBe("sync conflict from machine-a");
    expect(d.pullAfter).toBe(true);
    expect(d.pullContent).toBe(cloud);
    expect(d.nextState).toEqual({ lastSyncedVersionId: 8, lastSyncedHash: hash(cloud) });
  });

  it("both changed but base content unavailable → revision (safe fallback)", async () => {
    const local = "a\nx\n";
    const cloud = "a\ny\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash("a\nb\n") };
    const fetchBase = async () => null; // pruned / corrupt
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(8, cloud), fetchBase, merge, hash });
    expect(d.action).toBe("revision");
  });
});

describe("decideFile — member token", () => {
  it("member local-only edit → revision, not push", async () => {
    const base = "a\nb\n";
    const local = "a\nB\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(5, base), fetchBase: noFetch, merge, hash, isMember: true, hostname: "m1" });
    expect(d.action).toBe("revision");
    expect(d.note).toBe("sync conflict from m1");
  });

  it("member both-changed → revision without fetching base", async () => {
    const base = "a\nb\n";
    const local = "a\nB\n";
    const cloud = "a\nC\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash(base) };
    const d = await decideFile({ entry, localContent: local, remoteDoc: remote(8, cloud), fetchBase: noFetch, merge, hash, isMember: true });
    expect(d.action).toBe("revision");
  });
});

describe("decideFile — corruption / missing-file safety", () => {
  it("null lastSyncedHash (corrupt state) + remote unchanged → push (treated as local-changed)", async () => {
    const content = "a\nb\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: null };
    // Local differs from cloud so it's a real local change.
    const d = await decideFile({ entry, localContent: "a\nB\n", remoteDoc: remote(5, content), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("push");
  });

  it("null state but local already equals cloud → noop convergence", async () => {
    const content = "a\nb\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: null, lastSyncedHash: null };
    const d = await decideFile({ entry, localContent: content, remoteDoc: remote(5, content), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("noop");
    expect(d.nextState).toEqual({ lastSyncedVersionId: 5, lastSyncedHash: hash(content) });
  });

  it("local file missing + remote changed → pull (never push a deletion)", async () => {
    const cloud = "a\nb\nc\n";
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash("a\nb\n") };
    const d = await decideFile({ entry, localContent: null, remoteDoc: remote(8, cloud), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("pull");
    expect(d.content).toBe(cloud);
  });

  it("local file missing + remote unchanged → noop", async () => {
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash("a\nb\n") };
    const d = await decideFile({ entry, localContent: null, remoteDoc: remote(5, "a\nb\n"), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("noop");
  });
});

describe("decideFile — remote unpublish", () => {
  it("remoteDoc null → drop-mapping, local kept", async () => {
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash("a\n") };
    const d = await decideFile({ entry, localContent: "a\n", remoteDoc: null, fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("drop-mapping");
    expect(d.reason).toMatch(/local file kept/);
  });

  it("remoteDoc with null currentVersionId → drop-mapping", async () => {
    const entry = { slug: "d", localPath: "/d.md", lastSyncedVersionId: 5, lastSyncedHash: hash("a\n") };
    const d = await decideFile({ entry, localContent: "a\n", remoteDoc: remote(null, null), fetchBase: noFetch, merge, hash });
    expect(d.action).toBe("drop-mapping");
  });
});

describe("decideDirAdoptions", () => {
  const mk = (slug, vid) => [slug, { slug, currentVersionId: vid, content: "x", contentHash: hash("x") }];

  it("new remote doc under prefix → create-local", () => {
    const remoteBySlug = new Map([mk("newcloud", 3)]);
    const localBySlug = new Map();
    const r = decideDirAdoptions({ remoteBySlug, localBySlug, mapped: new Set(), isMember: false });
    expect(r.adopt).toEqual([{ action: "create-local", slug: "newcloud", reason: expect.any(String) }]);
  });

  it("new local file (admin) → create-remote", () => {
    const remoteBySlug = new Map();
    const localBySlug = new Map([["newlocal", { localPath: "/x/newlocal.md" }]]);
    const r = decideDirAdoptions({ remoteBySlug, localBySlug, mapped: new Set(), isMember: false });
    expect(r.adopt[0].action).toBe("create-remote");
    expect(r.adopt[0].slug).toBe("newlocal");
  });

  it("new local file (member) → skip-new-local with notice", () => {
    const remoteBySlug = new Map();
    const localBySlug = new Map([["newlocal", { localPath: "/x/newlocal.md" }]]);
    const r = decideDirAdoptions({ remoteBySlug, localBySlug, mapped: new Set(), isMember: true });
    expect(r.adopt[0].action).toBe("skip-new-local");
  });

  it("already-mapped slugs are skipped (handled by decideFile)", () => {
    const remoteBySlug = new Map([mk("known", 3)]);
    const localBySlug = new Map([["known", { localPath: "/x/known.md" }]]);
    const r = decideDirAdoptions({ remoteBySlug, localBySlug, mapped: new Set(["known"]), isMember: false });
    expect(r.adopt).toEqual([]);
  });

  it("local file that also exists remotely (unmapped) → adopted remote, not double-published", () => {
    const remoteBySlug = new Map([mk("both", 3)]);
    const localBySlug = new Map([["both", { localPath: "/x/both.md" }]]);
    const r = decideDirAdoptions({ remoteBySlug, localBySlug, mapped: new Set(), isMember: false });
    // create-local for the remote; the local side is NOT create-remote'd.
    expect(r.adopt.map((a) => a.action)).toEqual(["create-local"]);
  });
});
