import { describe, it, expect, afterEach } from "vitest";
import { gitRemoteBase, gitRepoUrl, originFromHeaders } from "./git-url";

function hdrs(map: Record<string, string>) {
  return { get: (n: string) => map[n.toLowerCase()] ?? null };
}

const ENV = process.env.HUB_BASE_URL;
afterEach(() => {
  if (ENV === undefined) delete process.env.HUB_BASE_URL;
  else process.env.HUB_BASE_URL = ENV;
});

describe("git-url", () => {
  it("prefers HUB_BASE_URL (trailing slash stripped)", () => {
    process.env.HUB_BASE_URL = "https://desk.example.com/";
    expect(gitRemoteBase(hdrs({ host: "ignored.test" }))).toBe("https://desk.example.com");
  });

  it("falls back to the request origin from forwarded headers", () => {
    delete process.env.HUB_BASE_URL;
    expect(
      gitRemoteBase(hdrs({ "x-forwarded-proto": "https", "x-forwarded-host": "staging.example.com" })),
    ).toBe("https://staging.example.com");
  });

  it("defaults localhost to http, else https", () => {
    delete process.env.HUB_BASE_URL;
    expect(originFromHeaders(hdrs({ host: "localhost:3000" }))).toBe("http://localhost:3000");
    expect(originFromHeaders(hdrs({ host: "desk.example.com" }))).toBe("https://desk.example.com");
  });

  it("uses a localhost dev default when nothing is available", () => {
    delete process.env.HUB_BASE_URL;
    expect(gitRemoteBase(undefined)).toBe("http://localhost:3000");
    expect(gitRemoteBase(hdrs({}))).toBe("http://localhost:3000");
  });

  it("gitRepoUrl assembles the full clone/push URL", () => {
    process.env.HUB_BASE_URL = "https://desk.example.com";
    expect(gitRepoUrl("alice", "my-project")).toBe(
      "https://desk.example.com/api/git/alice/my-project.git",
    );
  });
});
