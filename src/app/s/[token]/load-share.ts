import { resolveShare, recordView } from "@/lib/shares";

/**
 * Derive a short plain-text excerpt from markdown/HTML content:
 * strip code fences, HTML tags, markdown punctuation, URLs; collapse
 * whitespace; head to maxLen chars. Reusable for OG description and any
 * summary surface.
 */
export function excerptFrom(content: string, maxLen = 160): string {
  const flat = content
    .replace(/```[\s\S]*?```/g, " ")      // fenced code
    .replace(/<[^>]+>/g, " ")              // HTML tags
    .replace(/[#>*_`~\-\[\]!|]+/g, " ")   // md punctuation (including tables/images)
    .replace(/https?:\/\/\S+/g, " ")       // URLs
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > maxLen ? flat.slice(0, maxLen).trimEnd() + "…" : flat;
}

// Window (in days) before expiry within which we show the quiet "expiring soon"
// banner. Spec §3 / prototype: single-line notice, opt-in feel, not a modal.
const EXPIRING_SOON_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type ShareView = {
  kind: "md" | "html";
  title: string;
  content: string;
  /** Human stamp like "9 Jun 2026", derived from version.publishedAt. */
  updatedStamp: string;
  createdBy: string;
  /** The share's label — the visitor's display identity ("commenting as …"). */
  shareLabel: string;
  /** Whether this share permits link-visitor comments (per-share flag). */
  allowComments: boolean;
  /** The raw token, so the client composer can POST to the share-comment API. */
  token: string;
  /** True when the share expires within EXPIRING_SOON_DAYS. */
  expiresSoon: boolean;
  /** Formatted expiry date for the banner (e.g. "23 Jun 2026"), null if none. */
  expiresStamp: string | null;
};

/**
 * Format a Date as "9 Jun 2026" (day, short month, year). Locale-independent.
 */
export function formatStamp(d: Date): string {
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * Resolve a raw share token to a fully-formed view model, AND record the view.
 *
 * This is the page's entire data + guard layer, extracted from the RSC so it can
 * be unit-tested directly (testing RSC rendering is awkward). The page component
 * is a thin shell over this.
 *
 * - Returns null for every null cause from resolveShare (unknown / revoked /
 *   expired / unpublished) — indistinguishable to the caller, which renders the
 *   uniform 404.
 * - On a valid share it records the view (caps ip/ua live inside recordView).
 *   View logging failures never block the render — they are swallowed here.
 *
 * `opts.schedule` controls WHEN the recordView write runs. Default: awaited
 * inline (so unit tests can assert the row synchronously). The page passes
 * Next's `after()` so the write runs post-response and never lengthens the
 * render path. `opts.now` is injectable for deterministic expiresSoon tests.
 */
export type LoadShareOpts = {
  ip?: string;
  userAgent?: string;
  /**
   * Scheduler for the post-resolve view-log write. Default: run immediately
   * (returns the promise, which loadShareView awaits). The page passes Next's
   * `after()`, which returns void — the write is then deferred past the response.
   */
  schedule?: (task: () => Promise<void>) => void | Promise<void>;
  /** Injectable clock for the expiresSoon boundary. */
  now?: Date;
};

export async function loadShareView(
  token: string,
  opts?: LoadShareOpts,
): Promise<ShareView | null> {
  const now = opts?.now ?? new Date();
  const schedule =
    opts?.schedule ?? ((task: () => Promise<void>) => task());

  const resolved = await resolveShare(token);
  if (resolved === null) return null;

  const { doc, version, shareId, expiresAt, label, allowComments } = resolved;

  // A published doc must have a current version; if not, treat as not-there
  // rather than rendering an empty page (uniform 404).
  if (version === null) return null;

  // Record the view. The scheduler decides when this runs; failures are
  // swallowed so a logging hiccup never breaks the page. Default scheduler runs
  // it inline (awaited below); `after()` defers it past the response.
  const versionId = version.id;
  const logTask = async () => {
    try {
      await recordView(shareId, versionId, opts?.ip, opts?.userAgent);
    } catch {
      // view logging is best-effort
    }
  };
  const scheduled = schedule(logTask);
  // If the default (inline) scheduler returned a promise, await it so the row
  // is written before we return — `after()` returns void and is not awaited.
  if (scheduled instanceof Promise) await scheduled;

  const expiresSoon =
    expiresAt !== null &&
    expiresAt.getTime() - now.getTime() < EXPIRING_SOON_DAYS * MS_PER_DAY;

  return {
    kind: doc.format,
    title: doc.title,
    content: version.content,
    updatedStamp: formatStamp(version.publishedAt),
    createdBy: resolved.createdBy,
    shareLabel: label,
    allowComments,
    token,
    expiresSoon,
    expiresStamp: expiresAt ? formatStamp(expiresAt) : null,
  };
}
