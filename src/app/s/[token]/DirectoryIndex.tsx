import Link from "next/link";
import { formatStamp } from "./load-share";
import type { DirectoryDocEntry } from "@/lib/shares";

/**
 * The directory-share INDEX — a calm partner register of every published doc
 * under the shared folder. NOT a file manager: a quiet list of titles + updated
 * stamps + excerpts, each a link to the doc reader under the SAME token.
 *
 * Pure presentational RSC. Titles / excerpts / paths are data → plain-text JSX
 * only (never an HTML sink). Each link points at /s/<token>/<slug>; the per-doc
 * route re-verifies slug-under-prefix server-side, so a tampered href still
 * 404s.
 */
export default function DirectoryIndex({
  token,
  pathPrefix,
  createdBy,
  docs,
  expiresSoon,
  expiresStamp,
}: {
  token: string;
  pathPrefix: string;
  createdBy: string;
  docs: DirectoryDocEntry[];
  expiresSoon: boolean;
  expiresStamp: string | null;
}) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: "var(--font-serif)",
      }}
    >
      {expiresSoon && expiresStamp && (
        <div
          style={{
            background: "var(--warn-bg)",
            borderBottom: "1px solid var(--warn-border)",
          }}
        >
          <div
            style={{
              maxWidth: 720,
              margin: "0 auto",
              padding: "10px 24px",
              display: "flex",
              alignItems: "baseline",
              gap: 10,
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "var(--warn-ink)",
              }}
            >
              Notice
            </span>
            <span style={{ fontSize: 15, color: "var(--warn-ink)" }}>
              This link expires {expiresStamp}. Ask {createdBy} for a fresh one
              if you need it longer.
            </span>
          </div>
        </div>
      )}

      <header
        style={{
          borderBottom: "1px solid var(--hairline)",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            maxWidth: 720,
            margin: "0 auto",
            padding: "20px 24px 16px",
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              color: "var(--faint)",
              marginBottom: 4,
            }}
          >
            Shared folder
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 6px", letterSpacing: "-0.01em" }}>
            {pathPrefix}/
          </h1>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11.5,
              color: "var(--faint)",
            }}
          >
            {docs.length} {docs.length === 1 ? "document" : "documents"} · shared by {createdBy}
          </div>
        </div>
      </header>

      <main
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "32px 24px 64px",
        }}
      >
        {docs.length === 0 ? (
          <div
            style={{
              border: "1px dashed var(--hairline)",
              borderRadius: 10,
              padding: "40px 20px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 14,
            }}
          >
            Nothing here yet — documents added to this folder will appear
            automatically.
          </div>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {docs.map((d) => (
              <li key={d.slug}>
                <Link
                  href={`/s/${encodeURIComponent(token)}/${encodeURIComponent(d.slug)}`}
                  style={{
                    display: "block",
                    textDecoration: "none",
                    color: "var(--ink)",
                    border: "1px solid var(--hairline)",
                    borderRadius: 10,
                    background: "var(--surface)",
                    padding: "14px 18px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14 }}>
                    <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.005em", minWidth: 0 }}>
                      {d.title}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--faint)",
                        whiteSpace: "nowrap",
                        flex: "none",
                      }}
                    >
                      {formatStamp(d.updatedAt)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      color: "var(--ref-ink, var(--accent))",
                      marginTop: 3,
                    }}
                  >
                    {d.path}/
                  </div>
                  {d.excerpt && (
                    <div
                      style={{
                        fontSize: 13.5,
                        color: "var(--muted)",
                        lineHeight: 1.5,
                        marginTop: 6,
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                        overflow: "hidden",
                      }}
                    >
                      {d.excerpt}
                    </div>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}

        <footer
          style={{
            marginTop: 56,
            paddingTop: 20,
            borderTop: "1px solid var(--hairline)",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.05em",
              color: "var(--faint)",
            }}
          >
            Private link · shared by {createdBy} · do not forward
          </span>
        </footer>
      </main>
    </div>
  );
}
