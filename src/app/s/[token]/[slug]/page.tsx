import { headers } from "next/headers";
import { after } from "next/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import Markdown from "@/components/Markdown";
import { docPreviewDescription } from "@/lib/preview";
import { resolveShareDoc, recordView } from "@/lib/shares";
import { listComments } from "@/lib/comments";
import { formatStamp } from "../load-share";
import ShareComments from "../ShareComments";
import SuggestEdit from "../SuggestEdit";
import ReaderActions from "../ReaderActions";
import type { CommentDTO } from "@/app/(hub)/docs/[slug]/comments-view-model";

// Resolve fresh every request — revoke / expiry / unpublish / re-prefix must all
// take effect immediately; same force-dynamic discipline as the doc-share page.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string; slug: string }>;
}): Promise<Metadata> {
  const { token, slug } = await params;
  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) {
    // Uniform — never leak whether the slug exists / is outside the prefix.
    return { title: "Desk", description: "Shared document" };
  }
  const title = resolved.doc.title;
  const description = docPreviewDescription(resolved.doc);
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

function firstForwardedIp(xff: string | null): string | undefined {
  if (!xff) return undefined;
  const first = xff.split(",")[0]?.trim();
  return first ? first : undefined;
}

/**
 * A doc opened UNDER a directory-share token. resolveShareDoc is THE guard:
 * the doc must be published AND its path under the share's prefix, else uniform
 * 404 — a visitor can't read an arbitrary doc by passing a foreign slug.
 *
 * Reader chrome mirrors the doc-share page (minimal header + Copy/Download +
 * optional comments), with a back-to-index breadcrumb to /s/<token>.
 */
export default async function ShareDocPage({
  params,
}: {
  params: Promise<{ token: string; slug: string }>;
}) {
  const { token, slug } = await params;

  const resolved = await resolveShareDoc(token, slug);
  if (resolved === null) notFound();

  const { doc, version, share } = resolved;

  // Record a view per doc-open (shareId + this doc's current version id). Best-
  // effort, deferred past the response, never blocks the render.
  const h = await headers();
  const ip = firstForwardedIp(h.get("x-forwarded-for"));
  const userAgent = h.get("user-agent") ?? undefined;
  after(async () => {
    try {
      await recordView(share.shareId, version.id, ip, userAgent);
    } catch {
      // view logging is best-effort
    }
  });

  // Load the visible (unresolved) thread when this share permits comments.
  let comments: CommentDTO[] = [];
  if (share.allowComments) {
    const rows = await listComments(doc.id, { includeResolved: false });
    comments = rows.map((c) => ({
      id: c.id,
      authorName: c.authorName,
      authorKind: c.authorKind,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  const isHtml = doc.format === "html";
  const maxWidth = isHtml ? 1100 : 680;
  const updatedStamp = formatStamp(version.publishedAt);

  const commentsNode = share.allowComments ? (
    <>
      <div
        style={{
          maxWidth,
          margin: "0 auto",
          borderTop: "1px solid var(--hairline)",
        }}
      />
      <ShareComments
        token={token}
        label={share.label}
        initial={comments}
        endpoint={`/api/s/${encodeURIComponent(token)}/${encodeURIComponent(slug)}/comments`}
      />
    </>
  ) : null;

  // "Suggest an edit" — md-only, gated on the share's allow_edits flag (folder-
  // wide, independent of allowComments). Posts to the slug-scoped suggest route.
  const suggestNode =
    !isHtml && share.allowEdits ? (
      <>
        <div
          style={{
            maxWidth: 680,
            margin: "0 auto",
            borderTop: "1px solid var(--hairline)",
          }}
        />
        <SuggestEdit
          token={token}
          label={share.label}
          source={version.content}
          endpoint={`/api/s/${encodeURIComponent(token)}/${encodeURIComponent(slug)}/suggest`}
        />
      </>
    ) : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        fontFamily: isHtml ? undefined : "var(--font-serif)",
        display: isHtml ? "flex" : undefined,
        flexDirection: isHtml ? "column" : undefined,
      }}
    >
      <header
        style={{
          borderBottom: "1px solid var(--hairline)",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            maxWidth,
            margin: "0 auto",
            padding: "14px 24px 6px",
          }}
        >
          <Link
            href={`/s/${encodeURIComponent(token)}`}
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--muted)",
              textDecoration: "none",
            }}
          >
            ‹ {share.pathPrefix}/
          </Link>
        </div>
        <div
          style={{
            maxWidth,
            margin: "0 auto",
            padding: "0 24px 14px",
            display: "flex",
            alignItems: "baseline",
            justifyContent: "space-between",
            gap: 16,
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 500,
              fontStyle: "italic",
              color: "var(--muted)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              minWidth: 0,
            }}
          >
            {doc.title}
          </span>
          <span
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 6,
              flex: "none",
            }}
          >
            <span
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11.5,
                color: "var(--faint)",
                whiteSpace: "nowrap",
              }}
            >
              Updated {updatedStamp} · shared by {share.createdBy}
            </span>
            <ReaderActions token={token} source={version.content} slug={slug} />
          </span>
        </div>
      </header>

      {isHtml ? (
        <>
          <div style={{ flex: 1, display: "flex" }}>
            <iframe
              sandbox="allow-scripts"
              srcDoc={version.content}
              title={doc.title}
              style={{ flex: 1, width: "100%", border: "none", minHeight: "85vh" }}
            />
          </div>
          {commentsNode && <div style={{ marginTop: 40 }}>{commentsNode}</div>}
        </>
      ) : (
        <>
          <article
            style={{
              maxWidth: 680,
              margin: "0 auto",
              padding: "56px 24px 40px",
            }}
          >
            <Markdown content={version.content} register="partner" />
            <footer
              style={{
                marginTop: 64,
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
                Private link · shared by {share.createdBy} · do not forward
              </span>
            </footer>
          </article>
          {suggestNode}
          {commentsNode}
        </>
      )}
    </div>
  );
}
