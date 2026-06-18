import { headers } from "next/headers";
import Link from "next/link";
import { getPrincipal } from "@/lib/auth";
import { listDocs, searchDocs, scopeForPrincipal, type DocListItem } from "@/lib/docs";
import { listShares } from "@/lib/shares";
import UploadDoc from "./UploadDoc";
import DocsTree, { type DocRowData } from "./DocsTree";
import FolderSharesPanel from "./FolderSharesPanel";
import { dateStamp, deriveFolders, toFolderShareRows } from "./view-model";

export const dynamic = "force-dynamic";

/**
 * Project a service DocListItem into the serializable row the client tree
 * renders. Dates become pre-formatted stamps; `href` is the cross-mock click
 * destination (quarterly-report → its share-links surface as in the mock, but
 * here every doc just opens its own page).
 */
function toRowData(doc: DocListItem & { snippet?: string }): DocRowData {
  return {
    slug: doc.slug,
    path: doc.path,
    title: doc.title,
    audience: doc.audience,
    format: doc.format,
    versionCount: doc.versionCount,
    updated: dateStamp(doc.updatedAt),
    unresolvedComments: doc.unresolvedComments,
    unpublished: doc.unpublishedAt !== null,
    snippet: doc.snippet,
    href: `/docs/${doc.slug}`,
  };
}

export default async function DocsListPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ q?: string }>;
}) {
  const [{ q }, principal] = await Promise.all([
    searchParams,
    getPrincipal(await headers()),
  ]);

  // Layout already gated anonymous; here principal is admin | member.
  const isAdmin = principal.kind === "admin";
  const query = (q ?? "").trim();

  // Layout gates anonymous; principal.kind here is always admin | member.
  // Service layer handles audience scoping; no page-level filter needed.
  // With a query active we use full-text search (ranked, snippet per row);
  // otherwise the plain list. Both share the same row shape (searchDocs adds an
  // optional `snippet`), so the rendering path below is unchanged.
  // Membership-aware scope (Audiences v2): a member sees flag-visible docs PLUS
  // docs in any audience they belong to. Resolved once and reused.
  const scope = await scopeForPrincipal(principal);
  // When searching we still need the FULL (unfiltered) doc list to derive the
  // complete folder set — so the Move picker can target any folder, not just the
  // folders of the search hits. listDocs is cheap (slug/path/title only).
  const [docs, allDocsForFolders]: [
    (DocListItem & { snippet?: string })[],
    DocListItem[],
  ] = query
    ? await Promise.all([
        searchDocs(query, { includeUnpublished: isAdmin, scope }),
        listDocs({ includeUnpublished: isAdmin, scope }),
      ])
    : await (async () => {
        const list = await listDocs({ includeUnpublished: isAdmin, scope });
        return [list, list] as [DocListItem[], DocListItem[]];
      })();

  const rows = docs.map(toRowData);
  const allFolders = deriveFolders(allDocsForFolders);
  const folderCount = allFolders.length;

  // Admin-only: the home for directory (folder) shares. The per-doc Sharing
  // panel is doc-scoped, so dir shares live here as a disclosure.
  const folderShareRows = isAdmin
    ? toFolderShareRows(await listShares())
    : [];

  return (
    <div style={{ maxWidth: 920, margin: "0 auto", padding: "32px 20px 80px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
          marginBottom: 6,
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", margin: 0 }}>
          Docs
        </h1>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--faint)" }}>
            {docs.length} {docs.length === 1 ? "doc" : "docs"} · {folderCount}{" "}
            {folderCount === 1 ? "folder" : "folders"} · role: {principal.kind}
          </span>
          {isAdmin && <UploadDoc folders={allFolders} />}
        </div>
      </div>
      <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--muted)" }}>
        Published snapshots, organized by folder paths. Folders exist because docs are in them.
      </p>

      {/* GET form → ?q= ; server FTS over title/slug/body. */}
      <form method="GET" style={{ marginBottom: 18 }}>
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Search docs — matches show their folder path…"
          aria-label="Search docs"
          style={{
            width: "100%",
            padding: "9px 12px",
            fontSize: 13.5,
            fontFamily: "var(--font-sans)",
            border: "1px solid var(--hairline)",
            borderRadius: 8,
            background: "var(--surface)",
            color: "var(--ink)",
            outline: "none",
          }}
        />
      </form>

      {docs.length === 0 ? (
        <div
          style={{
            border: "1px dashed var(--hairline)",
            borderRadius: 10,
            padding: "40px 20px",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 13.5, fontWeight: 500, marginBottom: 4 }}>
            {query ? `No matches for “${query}”` : "Nothing published for your role yet"}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--muted)" }}>
            {query
              ? "Search covers titles, slugs and folder paths."
              : isAdmin
                ? "Upload a doc or drop a file anywhere on this page."
                : "Members see published docs once an admin publishes a snapshot."}
          </div>
        </div>
      ) : (
        <DocsTree docs={rows} query={query} isAdmin={isAdmin} allFolders={allFolders} />
      )}

      {isAdmin && <FolderSharesPanel rows={folderShareRows} />}

      {isAdmin && (
        <div style={{ marginTop: 22, display: "flex", alignItems: "center", justifyContent: "center", gap: 16, fontSize: 12, color: "var(--faint)" }}>
          <span>Drop a markdown or HTML file anywhere to upload.</span>
          <Link
            href="/distribution"
            style={{ color: "var(--accent)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
          >
            distribution view →
          </Link>
        </div>
      )}
    </div>
  );
}
