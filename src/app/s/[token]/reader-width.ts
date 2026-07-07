/**
 * Shared width constants for the public share reader (`/s/[token]` and
 * `/s/[token]/[slug]`). One measure for markdown docs, one for html
 * artifacts — consumed by the article wrapper AND all surrounding chrome
 * (header, expiring banner, suggest/comments dividers + sections) so they
 * stay visually aligned instead of drifting via scattered literals.
 *
 * Both values are OUTER widths (border-box; the global `* { box-sizing:
 * border-box }` reset means the 24px horizontal padding used throughout
 * these pages is included in the number, not added on top).
 *
 * MD_READER_WIDTH: 788 - 2*24 = 740px effective reading measure, tuned for
 * ~70-75 characters per line at the `.md-partner` 17px serif body size
 * (see globals.css). Keep this in sync with `.md-partner`'s own max-width.
 *
 * HTML_READER_WIDTH: unchanged from the pre-existing value — html shares
 * render through a sandboxed iframe (SandboxedHtml) that wants the wider
 * canvas; out of scope for the S1 readability pass.
 */
export const MD_READER_WIDTH = 788;
export const HTML_READER_WIDTH = 1100;
