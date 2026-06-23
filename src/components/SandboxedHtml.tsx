import type { CSSProperties } from "react";

/**
 * The single source of truth for how desk renders untrusted, uploaded HTML.
 *
 * `sandbox="allow-scripts"` and NOTHING ELSE. Crucially, never add
 * `allow-same-origin`: with both `allow-scripts` AND `allow-same-origin` a
 * frame can reach out and delete its own sandbox attribute, then run with
 * desk's origin — full access to cookies, storage, and same-origin APIs.
 * With scripts-only, the content runs in an opaque/null origin: it can render
 * and run its own JS, but cannot touch desk.
 *
 * Content is passed via `srcDoc` (inline, opaque origin) rather than a `src`
 * URL, so there is no separate same-origin HTTP response to attack.
 *
 * Both the public share reader (`/s/[token]`) and the hub doc viewer
 * (`/docs/[slug]` via HtmlPreview) render through this component, so the
 * sandbox policy lives in exactly one place — see SandboxedHtml.test.tsx for
 * the regression guard.
 */
export default function SandboxedHtml({
  content,
  title,
  style,
}: {
  content: string;
  title: string;
  /** Merged over the base style — e.g. `{ flex: 1 }` for the share reader's
   *  flex column. Cannot override the sandbox policy (that is hard-coded). */
  style?: CSSProperties;
}) {
  const baseStyle: CSSProperties = {
    width: "100%",
    border: "none",
    minHeight: "70vh",
  };
  return (
    <iframe
      sandbox="allow-scripts"
      srcDoc={content}
      title={title}
      style={{ ...baseStyle, ...style }}
    />
  );
}
