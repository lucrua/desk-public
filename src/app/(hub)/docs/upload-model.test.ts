import { describe, it, expect } from "vitest";
import {
  extensionOf,
  formatFromFilename,
  acceptFile,
  validateUpload,
  MAX_UPLOAD_BYTES,
} from "./upload-model";

describe("extensionOf", () => {
  it("returns the lowercased final extension", () => {
    expect(extensionOf("My File.MD")).toBe("md");
    expect(extensionOf("a.b.HTML")).toBe("html");
  });

  it("returns empty for no extension, dotfile, or trailing dot", () => {
    expect(extensionOf("README")).toBe("");
    expect(extensionOf(".env")).toBe("");
    expect(extensionOf("name.")).toBe("");
  });
});

describe("formatFromFilename", () => {
  it("maps md/markdown → md and html/htm → html", () => {
    expect(formatFromFilename("a.md")).toBe("md");
    expect(formatFromFilename("a.markdown")).toBe("md");
    expect(formatFromFilename("a.html")).toBe("html");
    expect(formatFromFilename("a.htm")).toBe("html");
  });

  it("returns null for unsupported extensions", () => {
    expect(formatFromFilename("a.pdf")).toBeNull();
    expect(formatFromFilename("a.txt")).toBeNull();
    expect(formatFromFilename("README")).toBeNull();
  });
});

describe("acceptFile", () => {
  it("returns the format for accepted extensions", () => {
    expect(acceptFile("report.md")).toBe("md");
    expect(acceptFile("report.markdown")).toBe("md");
    expect(acceptFile("deck.html")).toBe("html");
    expect(acceptFile("deck.htm")).toBe("html");
  });

  it("returns null for unsupported types", () => {
    expect(acceptFile("report.pdf")).toBeNull();
    expect(acceptFile("image.png")).toBeNull();
    expect(acceptFile("README")).toBeNull();
  });

  it("is case-insensitive (delegates to formatFromFilename)", () => {
    expect(acceptFile("REPORT.MD")).toBe("md");
    expect(acceptFile("DECK.HTML")).toBe("html");
  });
});

describe("validateUpload", () => {
  const base = {
    filename: "my-doc.md",
    byteSize: 100,
    slug: "my-doc",
    title: "My Doc",
  };

  it("passes a valid form, deriving format (no audience field — new docs default private)", () => {
    const r = validateUpload(base);
    expect(r).toEqual({ ok: true, format: "md" });
  });

  it("derives html format", () => {
    const r = validateUpload({
      ...base,
      filename: "deck.html",
    });
    expect(r).toEqual({ ok: true, format: "html" });
  });

  it("rejects unsupported file type", () => {
    const r = validateUpload({ ...base, filename: "doc.pdf" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported file type/);
  });

  it("rejects oversized files", () => {
    const r = validateUpload({ ...base, byteSize: MAX_UPLOAD_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large/i);
  });

  it("accepts a file exactly at the byte cap", () => {
    const r = validateUpload({ ...base, byteSize: MAX_UPLOAD_BYTES });
    expect(r.ok).toBe(true);
  });

  it("rejects an invalid slug", () => {
    const r = validateUpload({ ...base, slug: "My Doc" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Slug must match/);
  });

  it("rejects an empty title", () => {
    const r = validateUpload({ ...base, title: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Title is required/);
  });

  it("checks format before size (unsupported type wins)", () => {
    const r = validateUpload({ ...base, filename: "doc.pdf", byteSize: MAX_UPLOAD_BYTES + 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Unsupported file type/);
  });
});
