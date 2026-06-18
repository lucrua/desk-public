import { describe, it, expect } from "vitest";
import { downloadExt, downloadContentType, downloadFilename } from "./download";

describe("download derivation", () => {
  it("md → .md + text/markdown", () => {
    expect(downloadExt("md")).toBe("md");
    expect(downloadContentType("md")).toBe("text/markdown; charset=utf-8");
    expect(downloadFilename("partner-brief", "md")).toBe("partner-brief.md");
  });

  it("html → .html + text/html", () => {
    expect(downloadExt("html")).toBe("html");
    expect(downloadContentType("html")).toBe("text/html; charset=utf-8");
    expect(downloadFilename("artifact", "html")).toBe("artifact.html");
  });
});
