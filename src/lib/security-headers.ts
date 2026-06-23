/**
 * Desk-wide security response headers, wired in `next.config.ts` via `headers()`.
 *
 * Kept here (not inline in the config) so the policy is unit-testable and lives
 * in one place. These are a defense-in-depth backstop: the artifact iframe's
 * own isolation is enforced by the sandbox (see SandboxedHtml), independent of
 * these headers.
 *
 * NOTE on the CSP: it names ONLY `frame-ancestors`. Desk + Next.js rely on
 * inline hydration `<script>` and inline style attributes (the UI is built from
 * React `style={{}}` props), so a `default-src`/`script-src`/`style-src` policy
 * would break the app. A CSP that contains only `frame-ancestors` restricts who
 * may frame desk (clickjacking) and leaves scripts/styles/connections
 * untouched. Tightening script/style with nonces is a separate, larger effort.
 *
 * These headers apply to desk's own responses (incl. `/s/[token]` and
 * `/docs/[slug]`). They do NOT reach inside an artifact's `srcDoc` iframe —
 * that content runs in its own opaque origin with no HTTP response of its own.
 */
export const SECURITY_HEADERS: { key: string; value: string }[] = [
  // Clickjacking backstop.
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  // Legacy companion for browsers that ignore frame-ancestors.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Stop a response from being MIME-sniffed into an executable type.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Share URLs carry a 128-bit token — keep it out of cross-origin Referer.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];
