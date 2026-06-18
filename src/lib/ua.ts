/**
 * uaLabel — coarse, human-readable label for a raw User-Agent string.
 *
 * SECURITY: the input is an attacker-controlled raw string from a public
 * request header (capped 512 chars at storage, NOT sanitized). This is a PURE
 * string function: it never executes, interpolates into markup, or builds a
 * URL — it only classifies and returns a short display label. Callers render
 * the result as plain text (React escapes it), so even the fallback (a
 * truncated copy of the raw UA) is inert.
 *
 * Output shape: "App · OS", "Browser · OS", or a single token when only one
 * side is known. Unknown input falls back to the first 40 chars + "…".
 */

function detectClient(ua: string): string | null {
  // Order matters: in-app browsers (WhatsApp/Telegram) embed a real browser UA,
  // so check them first. Scripting clients (curl/node/python) are coarse-bucketed.
  if (/WhatsApp/i.test(ua)) return "WhatsApp";
  if (/Telegram/i.test(ua)) return "Telegram";
  if (/\bcurl\//i.test(ua) || /\bwget\//i.test(ua)) return "agent/script";
  if (/\bnode(?:\.js)?\b/i.test(ua) || /\baxios\//i.test(ua)) return "agent/script";
  if (/python|requests\//i.test(ua)) return "agent/script";
  // Browsers — Edge before Chrome (Edge UA contains "Chrome"), Chrome before
  // Safari (Chrome UA contains "Safari").
  if (/\bEdg(?:e|A|iOS)?\//i.test(ua)) return "Edge";
  if (/\bFirefox\//i.test(ua)) return "Firefox";
  if (/\bChrome\//i.test(ua) || /\bCriOS\//i.test(ua)) return "Chrome";
  if (/\bSafari\//i.test(ua)) return "Safari";
  return null;
}

function detectOs(ua: string): string | null {
  if (/iPhone|iPad|iPod|\biOS\b/i.test(ua)) return "iOS";
  if (/Android/i.test(ua)) return "Android";
  // "Mac OS X" but not iOS (already handled above).
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Linux/i.test(ua)) return "Linux";
  return null;
}

const FALLBACK_MAX = 40;

export function uaLabel(ua: string | null): string {
  if (ua == null) return "unknown";
  const trimmed = ua.trim();
  if (trimmed === "") return "unknown";

  const client = detectClient(trimmed);
  const os = detectOs(trimmed);

  // "agent/script" is a whole-client classification; OS noise isn't useful next
  // to it, so return it bare.
  if (client === "agent/script") return client;

  if (client && os) return `${client} · ${os}`;
  if (client) return client;
  if (os) return os;

  // Nothing recognized → inert truncated copy of the raw string.
  if (trimmed.length <= FALLBACK_MAX) return trimmed;
  return trimmed.slice(0, FALLBACK_MAX) + "…";
}
