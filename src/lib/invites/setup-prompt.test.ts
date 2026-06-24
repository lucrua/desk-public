import { describe, it, expect } from "vitest";
import {
  renderSetupPrompt,
  tokenCloneUrl,
  proposalHandle,
} from "./setup-prompt";

describe("setup-prompt", () => {
  const base = {
    ownerSlug: "acme",
    spaceSlug: "proj",
    gitHostBase: "https://desk.example.com",
    token: "TKN123",
  };

  describe("tokenCloneUrl", () => {
    it("injects the token as userinfo and points at the git transport path", () => {
      const url = tokenCloneUrl(base);
      expect(url).toBe("https://TKN123@desk.example.com/api/git/acme/proj.git");
    });
    it("handles a trailing slash + http scheme", () => {
      const url = tokenCloneUrl({ ...base, gitHostBase: "http://localhost:3000/" });
      expect(url).toBe("http://TKN123@localhost:3000/api/git/acme/proj.git");
    });
  });

  describe("proposalHandle", () => {
    it("sanitizes to a git-ref-safe segment, falls back to 'you'", () => {
      expect(proposalHandle("Jane Doe")).toBe("jane-doe");
      expect(proposalHandle("  ")).toBe("you");
      expect(proposalHandle(null)).toBe("you");
      expect(proposalHandle("a@b.com")).toBe("a-b-com");
    });
  });

  describe("renderSetupPrompt — push line switches on policy", () => {
    it("direct → push HEAD:main", () => {
      const p = renderSetupPrompt({ ...base, pushPolicy: "direct", handle: "jane" });
      expect(p).toContain("git push origin HEAD:main");
      expect(p).not.toContain("proposals/");
    });

    it("proposal → push HEAD:proposals/<handle>", () => {
      const p = renderSetupPrompt({ ...base, pushPolicy: "proposal", handle: "jane" });
      expect(p).toContain("git push origin HEAD:proposals/jane");
      expect(p).not.toContain("HEAD:main");
    });

    it("proposal with no handle → proposals/you", () => {
      const p = renderSetupPrompt({ ...base, pushPolicy: "proposal" });
      expect(p).toContain("HEAD:proposals/you");
    });

    it("includes the token-bearing clone URL + an INSTRUCTIONS.md instruction", () => {
      const p = renderSetupPrompt({ ...base, pushPolicy: "direct" });
      expect(p).toContain("https://TKN123@desk.example.com/api/git/acme/proj.git");
      expect(p).toContain("INSTRUCTIONS.md");
      expect(p).toContain("acme/proj");
    });
  });
});
