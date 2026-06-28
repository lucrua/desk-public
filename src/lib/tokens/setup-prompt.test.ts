import { describe, it, expect } from "vitest";
import { renderTokenSetupPrompt, hostParts } from "./setup-prompt";

describe("token setup-prompt", () => {
  const base = {
    gitHostBase: "https://desk.example.com",
    token: "TKN123",
  };

  describe("hostParts", () => {
    it("strips the scheme to the bare host and reads protocol from it", () => {
      expect(hostParts("https://desk.example.com")).toEqual({
        protocol: "https",
        host: "desk.example.com",
      });
    });
    it("handles a trailing slash + http scheme (keeps the port)", () => {
      expect(hostParts("http://localhost:3000/")).toEqual({
        protocol: "http",
        host: "localhost:3000",
      });
    });
    it("drops any path, keeping only host[:port]", () => {
      expect(hostParts("https://desk.example.com/api/git/")).toEqual({
        protocol: "https",
        host: "desk.example.com",
      });
    });
    it("defaults protocol to https when no scheme is present", () => {
      expect(hostParts("desk.example.com")).toEqual({
        protocol: "https",
        host: "desk.example.com",
      });
    });
  });

  describe("renderTokenSetupPrompt", () => {
    it("injects the bare host (scheme stripped) into the credential host= line", () => {
      const p = renderTokenSetupPrompt(base);
      expect(p).toContain("host=desk.example.com");
      // The host= line must NOT carry the scheme.
      expect(p).not.toContain("host=https://");
    });

    it("carries the raw token in the password= field", () => {
      const p = renderTokenSetupPrompt(base);
      expect(p).toContain("password=TKN123");
    });

    it("includes both commands: credential.helper store + git credential approve", () => {
      const p = renderTokenSetupPrompt(base);
      expect(p).toContain("git config --global credential.helper store");
      expect(p).toContain("git credential approve");
    });

    it("renders a correct, newline-terminated printf record (literal \\n, trailing \\n)", () => {
      const p = renderTokenSetupPrompt(base);
      expect(p).toContain(
        "printf 'protocol=https\\nhost=desk.example.com\\nusername=git\\npassword=TKN123\\n' | git credential approve",
      );
    });

    it("handles a trailing-slash host edge → still a bare host in host=", () => {
      const p = renderTokenSetupPrompt({ ...base, gitHostBase: "https://desk.example.com/" });
      expect(p).toContain("host=desk.example.com");
      expect(p).not.toContain("host=https://");
      expect(p).not.toContain("desk.example.com/");
    });

    it("uses http protocol when the host base is http (dev/localhost)", () => {
      const p = renderTokenSetupPrompt({ gitHostBase: "http://localhost:3000", token: "T2" });
      expect(p).toContain("protocol=http\\nhost=localhost:3000");
      expect(p).toContain("password=T2");
    });

    it("names the bare host in the agent-facing prose line", () => {
      const p = renderTokenSetupPrompt(base);
      expect(p).toContain("clone/push to `desk.example.com`");
    });
  });
});
