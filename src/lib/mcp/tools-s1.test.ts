/**
 * Unit tests for the S1 MCP tools: set_doc_path, list_events, and the new
 * publish_doc / list_docs / create_share parameters (path, base_version_id,
 * path_prefix, pinned_version_id). Handlers are exercised directly, like
 * tools.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resetDb, seedAudiences, publishDocOk, seedSpace, seedUser } from "@/test/db";
import { getDocBySlug } from "@/lib/docs";
import { resolveShare } from "@/lib/shares";
import type { Principal } from "@/lib/auth";
import { TOOLS, type ToolDef } from "./tools";

const admin: Principal = { kind: "admin", name: "Admin" };
const member: Principal = { kind: "member", name: "Member" };

function tool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}
async function run(name: string, principal: Principal, args: Record<string, unknown> = {}) {
  return tool(name).handler(principal, args as never);
}
function structured(res: Awaited<ReturnType<ToolDef["handler"]>>) {
  return res.structuredContent as Record<string, unknown>;
}

const DOC = {
  slug: "m-doc",
  title: "M",
  sourcePath: "os/m.md",
  audience: "team",
  format: "md" as const,
  content: "# v1",
  by: "lucas",
};
const HIDDEN = { ...DOC, slug: "m-hidden", audience: "pedro" };

describe("MCP — registry includes the S1 tools", () => {
  it("update_doc (merged set_doc_path + set_doc_owner) and list_events are registered", () => {
    expect(TOOLS.find((t) => t.name === "update_doc")).toBeTruthy();
    expect(TOOLS.find((t) => t.name === "list_events")).toBeTruthy();
    // The granular predecessors were merged away in the Slice-1.5 (D8) audit.
    expect(TOOLS.find((t) => t.name === "set_doc_path")).toBeUndefined();
    expect(TOOLS.find((t) => t.name === "set_doc_owner")).toBeUndefined();
  });
});

describe("MCP update_doc — path", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDocOk(DOC);
  });

  it("admin moves a doc; payload reports the new path", async () => {
    const res = await run("update_doc", admin, { slug: "m-doc", path: "os/canon" });
    expect(res.isError).toBeFalsy();
    expect(structured(res)).toMatchObject({ path: "os/canon" });
    const doc = await getDocBySlug("m-doc");
    expect(doc!.doc.path).toBe("os/canon");
  });

  it("member is forbidden", async () => {
    const res = await run("update_doc", member, { slug: "m-doc", path: "x" });
    expect(res.isError).toBe(true);
  });

  it("invalid path → error", async () => {
    const res = await run("update_doc", admin, { slug: "m-doc", path: "BAD" });
    expect(res.isError).toBe(true);
  });

  it("unknown slug → error", async () => {
    const res = await run("update_doc", admin, { slug: "nope", path: "x" });
    expect(res.isError).toBe(true);
  });
});

describe("MCP list_events", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    // Read access is space-scoped. The MCP `member` principal carries no
    // email/tokenName → resolves to no users-row → sees only PUBLIC/UNLISTED
    // spaces. m-doc lands in an unlisted space (visible); m-hidden in a private
    // space the member isn't in (hidden).
    const owner = await seedUser({ email: "le-owner@x.com", displayName: "Owner", role: "admin" });
    const openSpace = await seedSpace({ slug: "le-open", ownerId: owner, visibility: "unlisted" });
    const privSpace = await seedSpace({ slug: "le-priv", ownerId: owner, visibility: "private" });
    await publishDocOk({ ...DOC, spaceId: openSpace });
    await publishDocOk({ ...HIDDEN, spaceId: privSpace });
  });

  it("admin sees both spaces + a nextCursor", async () => {
    const res = await run("list_events", admin, {});
    const s = structured(res);
    const events = s.events as Array<{ payload: { slug: string } }>;
    const slugs = events.map((e) => e.payload.slug);
    expect(slugs).toEqual(expect.arrayContaining(["m-doc", "m-hidden"]));
    expect(typeof s.nextCursor).toBe("number");
  });

  it("member is space-scoped (no events for spaces they're not in)", async () => {
    const res = await run("list_events", member, {});
    const events = (structured(res).events as Array<{ payload: { slug: string } }>).map(
      (e) => e.payload.slug,
    );
    expect(events).toContain("m-doc");
    expect(events).not.toContain("m-hidden");
  });

  it("kinds filter is honoured", async () => {
    const res = await run("list_events", admin, { kinds: ["doc.published"] });
    const kinds = (structured(res).events as Array<{ kind: string }>).map((e) => e.kind);
    expect(kinds.every((k) => k === "doc.published")).toBe(true);
  });
});

describe("MCP publish_doc — path + base_version_id", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("path on publish is stored", async () => {
    const res = await run("publish_doc", admin, {
      slug: "mp",
      title: "MP",
      source_path: "os/mp.md",
      audience: "team",
      format: "md",
      content: "# x",
      path: "os/canon",
    });
    expect(res.isError).toBeFalsy();
    const doc = await getDocBySlug("mp");
    expect(doc!.doc.path).toBe("os/canon");
  });

  it("invalid path → error", async () => {
    const res = await run("publish_doc", admin, {
      slug: "mp2",
      title: "MP",
      source_path: "os/mp.md",
      audience: "team",
      format: "md",
      content: "# x",
      path: "BAD",
    });
    expect(res.isError).toBe(true);
  });

  it("stale base_version_id → conflict error result", async () => {
    const v1 = await publishDocOk({ ...DOC, slug: "mp3", by: "lucas" });
    await publishDocOk({ ...DOC, slug: "mp3", content: "# v2", by: "lucas" });
    const res = await run("publish_doc", admin, {
      slug: "mp3",
      title: "M",
      source_path: "os/m.md",
      audience: "team",
      format: "md",
      content: "# v3",
      base_version_id: v1.versionId,
    });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res)).toContain("conflict");
  });
});

describe("MCP list_docs — path_prefix", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDocOk({ ...DOC, slug: "ld-os", path: "os" });
    await publishDocOk({ ...DOC, slug: "ld-canon", path: "os/canon" });
    await publishDocOk({ ...DOC, slug: "ld-team", path: "team" });
  });

  it("filters to the folder + descendants", async () => {
    const res = await run("list_docs", admin, { path_prefix: "os" });
    const docs = structured(res).docs as Array<{ slug: string }>;
    expect(docs.map((d) => d.slug).sort()).toEqual(["ld-canon", "ld-os"]);
  });

  it("invalid path_prefix → error", async () => {
    const res = await run("list_docs", admin, { path_prefix: "BAD" });
    expect(res.isError).toBe(true);
  });
});

describe("MCP create_share — pinned_version_id", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
  });

  it("pins the link to a version", async () => {
    const v1 = await publishDocOk({ ...DOC, slug: "cs", by: "lucas" });
    await publishDocOk({ ...DOC, slug: "cs", content: "# v2", by: "lucas" });
    const res = await run("create_share", admin, {
      doc_slug: "cs",
      label: "Pinned",
      pinned_version_id: v1.versionId,
    });
    expect(res.isError).toBeFalsy();
    const url = structured(res).shareUrl as string;
    const token = url.split("/s/")[1];
    const resolved = await resolveShare(token);
    expect(resolved!.pinned).toBe(true);
    expect(resolved!.version!.content).toBe("# v1");
  });

  it("pinned_version_id from a different doc → error", async () => {
    await publishDocOk({ ...DOC, slug: "cs2", by: "lucas" });
    const otherV = await publishDocOk({ ...DOC, slug: "cs-other", content: "# o", by: "lucas" });
    const res = await run("create_share", admin, {
      doc_slug: "cs2",
      label: "Bad",
      pinned_version_id: otherV.versionId,
    });
    expect(res.isError).toBe(true);
  });
});

describe("MCP create_directory_share", () => {
  beforeEach(async () => {
    await resetDb();
    await seedAudiences();
    await publishDocOk({ ...DOC, slug: "fin-q3", path: "finance/q3", content: "# q3", by: "lucas" });
  });

  it("admin creates a directory share → directory mode + 43-char token", async () => {
    const res = await run("create_directory_share", admin, { path_prefix: "finance", label: "Folder" });
    expect(res.isError).toBeFalsy();
    const out = structured(res);
    expect(out.mode).toBe("directory");
    const token = (out.shareUrl as string).split("/s/")[1];
    expect(token).toHaveLength(43);
    // It resolves as a directory share, and exposes the published doc.
    const { resolveDirectoryShare, resolveShareDoc } = await import("@/lib/shares");
    expect(await resolveDirectoryShare(token)).not.toBeNull();
    expect(await resolveShareDoc(token, "fin-q3")).not.toBeNull();
  });

  it("root prefix ('') → error", async () => {
    const res = await run("create_directory_share", admin, { path_prefix: "", label: "Root" });
    expect(res.isError).toBe(true);
  });

  it("member → admin-only error", async () => {
    const res = await run("create_directory_share", member, { path_prefix: "finance", label: "x" });
    expect(res.isError).toBe(true);
  });
});
