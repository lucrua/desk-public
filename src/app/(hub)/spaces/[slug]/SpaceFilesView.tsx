import Link from "next/link";

/**
 * Full git-tree file view (Web-author W1.4). Lists EVERY committed file in the
 * space's `main` tree — not just projected docs — so uploaded non-doc files
 * (images, PDFs, data) are visible too. A doc-type file links to its rendered
 * page (`/docs/[slug]`); any other file links to the raw route
 * (`/api/spaces/[slug]/raw/<path>`). Server-rendered from `listSpaceFiles`; no
 * client state.
 */
export type SpaceFileRow = {
  path: string;
  isDoc: boolean;
  /** The rendered-doc slug for a doc-type file (else undefined). */
  docSlug?: string;
};

export default function SpaceFilesView({
  slug,
  files,
}: {
  slug: string;
  files: SpaceFileRow[];
}) {
  if (files.length === 0) {
    return (
      <p style={{ fontSize: 13, color: "var(--faint)", margin: 0 }}>
        No files yet. Create a doc or upload a file above, or push to this space.
      </p>
    );
  }
  return (
    <ul
      aria-label="Files in this space"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        border: "1px solid var(--hairline)",
        borderRadius: 10,
        overflow: "hidden",
        background: "var(--surface)",
      }}
    >
      {files.map((f, i) => {
        const href = f.isDoc && f.docSlug
          ? `/docs/${f.docSlug}`
          : `/api/spaces/${slug}/raw/${f.path}`;
        return (
          <li key={f.path}>
            <Link
              href={href}
              prefetch={false}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "9px 14px",
                borderTop: i === 0 ? "none" : "1px solid var(--hairline)",
                textDecoration: "none",
                color: "var(--ink)",
                background: "var(--surface)",
              }}
            >
              <span aria-hidden="true" style={{ color: "var(--faint)", fontSize: 12 }}>
                {f.isDoc ? "▢" : "⬓"}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
                {f.path}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  color: "var(--faint)",
                  textTransform: "uppercase",
                }}
              >
                {f.isDoc ? "doc" : "raw"}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
