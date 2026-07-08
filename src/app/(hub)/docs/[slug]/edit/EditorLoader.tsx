"use client";

import dynamic from "next/dynamic";

/**
 * Thin client wrapper that lazy-loads the CodeMirror editor island with
 * `ssr: false`. Keeping the dynamic import behind a client boundary means the
 * heavy editor bundle is only fetched on the /edit route — reader routes
 * (/docs/[slug], /s/[token]) never pull CodeMirror.
 */
const EditorIsland = dynamic(() => import("./EditorIsland"), {
  ssr: false,
  loading: () => (
    <div style={{ fontSize: 13, color: "var(--faint)", padding: "40px 0" }}>
      Loading editor…
    </div>
  ),
});

export default function EditorLoader(props: {
  slug: string;
  initialContent: string;
  canPublishDirect: boolean;
  spaceOwner?: string;
  spaceSlug?: string;
  baseCommit?: string | null;
}) {
  return <EditorIsland {...props} />;
}
