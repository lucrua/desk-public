import { describe, it, expect } from "vitest";
import { parseGitRequest, segmentsAfterMount } from "./route-parse";

function q(s: string): URLSearchParams {
  return new URLSearchParams(s);
}

describe("git route-parse", () => {
  describe("segmentsAfterMount", () => {
    it("strips the /api/git/ mount", () => {
      expect(segmentsAfterMount("/api/git/lucas/acme.git/info/refs")).toEqual([
        "lucas",
        "acme.git",
        "info",
        "refs",
      ]);
    });
    it("returns null without the mount prefix", () => {
      expect(segmentsAfterMount("/api/docs/x")).toBeNull();
    });
  });

  describe("parseGitRequest — recognized shapes", () => {
    it("GET info/refs?service=git-upload-pack → fetch advert", () => {
      const p = parseGitRequest(["lucas", "acme.git", "info", "refs"], "GET", q("service=git-upload-pack"));
      expect(p).toEqual({ owner: "lucas", space: "acme", service: "git-upload-pack", servicePath: "info/refs" });
    });
    it("GET info/refs?service=git-receive-pack → push advert", () => {
      const p = parseGitRequest(["lucas", "acme.git", "info", "refs"], "GET", q("service=git-receive-pack"));
      expect(p?.service).toBe("git-receive-pack");
      expect(p?.servicePath).toBe("info/refs");
    });
    it("POST git-upload-pack → fetch", () => {
      const p = parseGitRequest(["lucas", "acme.git", "git-upload-pack"], "POST", q(""));
      expect(p).toEqual({ owner: "lucas", space: "acme", service: "git-upload-pack", servicePath: "git-upload-pack" });
    });
    it("POST git-receive-pack → push", () => {
      const p = parseGitRequest(["lucas", "acme.git", "git-receive-pack"], "POST", q(""));
      expect(p?.service).toBe("git-receive-pack");
    });
  });

  describe("parseGitRequest — rejected shapes (→ null → uniform 404)", () => {
    it("missing .git suffix", () => {
      expect(parseGitRequest(["lucas", "acme", "info", "refs"], "GET", q("service=git-upload-pack"))).toBeNull();
    });
    it("dumb-HTTP object path", () => {
      expect(parseGitRequest(["lucas", "acme.git", "objects", "info", "packs"], "GET", q(""))).toBeNull();
    });
    it("info/refs with no service (dumb HTTP)", () => {
      expect(parseGitRequest(["lucas", "acme.git", "info", "refs"], "GET", q(""))).toBeNull();
    });
    it("unknown service value", () => {
      expect(parseGitRequest(["lucas", "acme.git", "info", "refs"], "GET", q("service=evil"))).toBeNull();
    });
    it("bad owner segment (traversal attempt)", () => {
      expect(parseGitRequest(["..", "acme.git", "git-upload-pack"], "POST", q(""))).toBeNull();
    });
    it("bad space segment", () => {
      expect(parseGitRequest(["lucas", "Bad Space.git", "git-upload-pack"], "POST", q(""))).toBeNull();
    });
    it("too few segments", () => {
      expect(parseGitRequest(["lucas", "acme.git"], "POST", q(""))).toBeNull();
    });
    it("wrong method for the service path", () => {
      // GET on the RPC endpoints is not valid.
      expect(parseGitRequest(["lucas", "acme.git", "git-upload-pack"], "GET", q(""))).toBeNull();
    });
  });
});
