import { describe, it, expect } from "vitest";
import { uaLabel } from "./ua";

describe("uaLabel", () => {
  it("Chrome on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
    expect(uaLabel(ua)).toBe("Chrome · Android");
  });

  it("Safari on macOS", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15";
    expect(uaLabel(ua)).toBe("Safari · macOS");
  });

  it("Safari on iOS (iPhone)", () => {
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";
    expect(uaLabel(ua)).toBe("Safari · iOS");
  });

  it("WhatsApp in-app browser → WhatsApp · iOS (not Safari)", () => {
    // WhatsApp's in-app UA embeds a Safari/Mobile token; the app must win.
    const ua =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WhatsApp/2.24.1";
    expect(uaLabel(ua)).toBe("WhatsApp · iOS");
  });

  it("Telegram in-app on Android", () => {
    const ua =
      "Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Mobile Safari/537.36 Telegram-Android/10.2";
    expect(uaLabel(ua)).toBe("Telegram · Android");
  });

  it("Edge on Windows (Edge before Chrome)", () => {
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
    expect(uaLabel(ua)).toBe("Edge · Windows");
  });

  it("Firefox on Linux", () => {
    const ua = "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0";
    expect(uaLabel(ua)).toBe("Firefox · Linux");
  });

  it("curl → agent/script (no OS noise)", () => {
    expect(uaLabel("curl/8.4.0")).toBe("agent/script");
  });

  it("python-requests → agent/script", () => {
    expect(uaLabel("python-requests/2.31.0")).toBe("agent/script");
  });

  it("null / empty → unknown", () => {
    expect(uaLabel(null)).toBe("unknown");
    expect(uaLabel("")).toBe("unknown");
    expect(uaLabel("   ")).toBe("unknown");
  });

  it("unrecognized short string returned verbatim", () => {
    expect(uaLabel("MysteryBot")).toBe("MysteryBot");
  });

  it("hostile UA (XSS-looking) → inert truncated fallback, never markup", () => {
    const hostile =
      '<img src=x onerror="alert(document.cookie)">evilevilevilevilevilevilevil';
    const out = uaLabel(hostile);
    // It's a pure string fn — nothing executes. The value is just the first
    // 40 chars + ellipsis, which React will escape when rendered as text.
    expect(out).toBe(hostile.slice(0, 40) + "…");
    expect(out.length).toBe(41); // 40 chars + "…"
    // Sanity: it is plainly the literal junk, not an interpreted tag.
    expect(out.startsWith("<img src=x")).toBe(true);
  });

  it("long unrecognized UA truncated to 40 chars + ellipsis", () => {
    const ua = "Z".repeat(200);
    expect(uaLabel(ua)).toBe("Z".repeat(40) + "…");
  });
});
