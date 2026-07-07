import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import { searchDocs, scopeForPrincipal, type DocSearchItem } from "@/lib/docs";
import SnippetLine from "../docs/SnippetLine";

export const dynamic = "force-dynamic";

const labelStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 9.5,
  letterSpacing: "0.06em",
  textTransform: "uppercase" as const,
  color: "var(--faint)",
} as const;

/**
 * `/search` — the global doc search surface (D2). A thin UI over the
 * already-built, already-viewer-scoped `searchDocs()`: this page does no
 * boundary work of its own, it just mirrors the same principal → scope
 * resolution `GET /api/docs?q=` and `/catalog` use (`scopeForPrincipal`), so a
 * member searching here sees exactly the docs they'd see anywhere else — never
 * more.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const [principal, sp] = await Promise.all([
    getPrincipal(await headers()),
    searchParams,
  ]);

  const q = (sp.q ?? "").trim();

  let results: DocSearchItem[] = [];
  if (q.length > 0) {
    const scope = await scopeForPrincipal(principal);
    results = await searchDocs(q, {
      includeUnpublished: principal.kind === "admin",
      scope,
    });
  }

  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "32px 20px 80px" }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
        Search
      </h1>
      <p style={{ margin: "4px 0 24px", fontSize: 13, color: "var(--muted)", lineHeight: 1.55 }}>
        Search doc titles and content across every space you can see.
      </p>

      <form action="/search" method="get" style={{ marginBottom: 24 }}>
        <input
          type="text"
          name="q"
          defaultValue={q}
          placeholder="Search docs…"
          aria-label="Search docs"
          autoFocus
          style={{
            width: "100%",
            fontSize: 14,
            padding: "10px 14px",
            borderRadius: 8,
            border: "1px solid var(--hairline)",
            background: "var(--surface)",
            color: "var(--ink)",
            fontFamily: "var(--font-sans)",
          }}
        />
      </form>

      {q.length === 0 ? (
        <EmptyPrompt />
      ) : results.length === 0 ? (
        <NoResults q={q} />
      ) : (
        <>
          <div style={{ ...labelStyle, marginBottom: 8 }}>
            {results.length} {results.length === 1 ? "result" : "results"} for &ldquo;{q}&rdquo;
          </div>
          <div
            style={{
              border: "1px solid var(--hairline)",
              borderRadius: 10,
              overflow: "hidden",
            }}
          >
            {results.map((r, i) => (
              <ResultRow key={r.slug} doc={r} first={i === 0} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ResultRow({ doc, first }: { doc: DocSearchItem; first: boolean }) {
  return (
    <div
      style={{
        padding: "14px 16px",
        borderTop: first ? "none" : "1px solid var(--hairline)",
        background: "var(--surface)",
      }}
    >
      <Link
        href={`/docs/${doc.slug}`}
        style={{
          fontSize: 14.5,
          fontWeight: 600,
          color: "var(--ink)",
          textDecoration: "none",
        }}
      >
        {doc.title}
      </Link>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--faint)",
          fontFamily: "var(--font-mono)",
          margin: "3px 0 6px",
        }}
      >
        {doc.spaceSlug ? `${doc.spaceSlug}/` : ""}
        {doc.path ? `${doc.path}/` : ""}
        {doc.slug}
      </div>
      <SnippetLine snippet={doc.snippet} />
    </div>
  );
}

function EmptyPrompt() {
  return (
    <div
      style={{
        border: "1px dashed var(--hairline-strong)",
        borderRadius: 10,
        background: "var(--surface-alt)",
        padding: "28px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ ...labelStyle, marginBottom: 8 }}>search docs</div>
      <p style={{ margin: "0 auto", maxWidth: 460, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        Type a query above to search doc titles and content across every space
        you can see. Title matches rank first.
      </p>
    </div>
  );
}

function NoResults({ q }: { q: string }) {
  return (
    <div
      style={{
        border: "1px dashed var(--hairline-strong)",
        borderRadius: 10,
        background: "var(--surface-alt)",
        padding: "28px 24px",
        textAlign: "center",
      }}
    >
      <div style={{ ...labelStyle, marginBottom: 8 }}>no results</div>
      <p style={{ margin: "0 auto", maxWidth: 460, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
        Nothing matched &ldquo;{q}&rdquo;. Try a different word, or check the
        spelling — search covers doc titles and body content in every space
        you can see.
      </p>
    </div>
  );
}
