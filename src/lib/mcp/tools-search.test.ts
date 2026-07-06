/**
 * Unit tests for the search_docs MCP tool and the list_docs `q` → FTS upgrade.
 * Handlers are exercised directly, like tools-s1.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  resetDb,
  publishDocOk,
  seedDevMemberInDefaultSpace,
  seedSpace,
  seedUser,
} from "@/test/db";
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
function docs(res: Awaited<ReturnType<ToolDef["handler"]>>) {
  return (res.structuredContent as { docs: Array<Record<string, unknown>> }).docs;
}

describe("MCP — search_docs registered (registry 32)", () => {
  it("search_docs is registered", () => {
    expect(TOOLS.find((t) => t.name === "search_docs")).toBeTruthy();
  });
});

describe("MCP search_docs", () => {
  beforeEach(async () => {
    await resetDb();
    // Member reads docs in the default `workspace` space.
    await seedDevMemberInDefaultSpace();
  });

  it("staff only — anonymous is rejected", async () => {
    const res = await run("search_docs", { kind: "anonymous", name: "anon" } as Principal, { q: "x" });
    expect(res.isError).toBe(true);
  });

  it("empty query returns no docs", async () => {
    const res = await run("search_docs", admin, { q: "  " });
    expect(docs(res)).toEqual([]);
  });

  it("ranks title matches first and bolds the matched term in the snippet", async () => {
    await publishDocOk({
      slug: "title-hit",
      title: "Comet Survey",
      sourcePath: "a.md",
      format: "md",
      content: "unrelated body",
      by: "lucas",
    });
    await publishDocOk({
      slug: "body-hit",
      title: "Other Heading",
      sourcePath: "b.md",
      format: "md",
      content: "a passage mentioning comet only in the body",
      by: "lucas",
    });
    const res = await run("search_docs", admin, { q: "comet" });
    const out = docs(res);
    const slugs = out.map((d) => d.slug);
    expect(slugs.indexOf("title-hit")).toBeLessThan(slugs.indexOf("body-hit"));
    // Snippet re-encoded to markdown bold (never raw delimiters / HTML).
    const bodyRow = out.find((d) => d.slug === "body-hit")!;
    expect(bodyRow.snippet as string).toContain("**comet**");
    expect(bodyRow.snippet as string).not.toContain("<b>");
    expect(bodyRow.snippet as string).not.toMatch(/[\x02\x03]/);
  });

  it("member scoping — a doc in a space they're not in is absent", async () => {
    // hidden lives in a SEPARATE private space the dev-member isn't in.
    const owner = await seedUser({ email: "pulsar-owner@x.com", displayName: "Owner", role: "admin" });
    const hiddenSpace = await seedSpace({ slug: "pulsar-space", ownerId: owner, visibility: "private" });
    await publishDocOk({
      slug: "hidden",
      title: "Hidden Pulsar",
      sourcePath: "h.md",
      format: "md",
      content: "pulsar",
      by: "lucas",
      spaceId: hiddenSpace,
    });
    await publishDocOk({
      slug: "shown",
      title: "Shown Pulsar",
      sourcePath: "s.md",
      format: "md",
      content: "pulsar",
      by: "lucas",
    });
    const out = docs(await run("search_docs", member, { q: "pulsar" }));
    const slugs = out.map((d) => d.slug);
    expect(slugs).toContain("shown");
    expect(slugs).not.toContain("hidden");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 3; i++) {
      await publishDocOk({
        slug: `quark-${i}`,
        title: `Quark ${i}`,
        sourcePath: `q${i}.md`,
        format: "md",
        content: "quark body",
        by: "lucas",
      });
    }
    const out = docs(await run("search_docs", admin, { q: "quark", limit: 2 }));
    expect(out.length).toBe(2);
  });

  it("XSS: a body with <img onerror=…> yields a markdown snippet with no <b> / no raw tag markup from ts_headline", async () => {
    await publishDocOk({
      slug: "xss",
      title: "Xss",
      sourcePath: "x.md",
      format: "md",
      content: "lead in <img src=x onerror=alert(1)> photonword trailing text",
      by: "lucas",
    });
    const out = docs(await run("search_docs", admin, { q: "photonword" }));
    const row = out[0];
    expect(row).toBeTruthy();
    const snippet = row.snippet as string;
    // ts_headline default markup absent; match bolded as data.
    expect(snippet).not.toContain("<b>");
    expect(snippet).toContain("**photonword**");
    // No control-char delimiters leak into the MCP text channel.
    expect(snippet).not.toMatch(/[\x02\x03]/);
  });
});

describe("MCP list_docs q → FTS", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("q runs full-text search over content (not just title/slug), with snippet", async () => {
    await publishDocOk({
      slug: "deep",
      title: "Nothing Relevant",
      sourcePath: "d.md",
      format: "md",
      content: "this body mentions helium prominently",
      by: "lucas",
    });
    const out = docs(await run("list_docs", admin, { q: "helium" }));
    const row = out.find((d) => d.slug === "deep");
    expect(row).toBeTruthy();
    expect(row!.snippet as string).toContain("**helium**");
  });

  it("no q → plain list, no snippet", async () => {
    await publishDocOk({
      slug: "plain",
      title: "Plain",
      sourcePath: "p.md",
      format: "md",
      content: "body",
      by: "lucas",
    });
    const out = docs(await run("list_docs", admin, {}));
    const row = out.find((d) => d.slug === "plain");
    expect(row).toBeTruthy();
    expect(row!.snippet).toBeUndefined();
  });
});
