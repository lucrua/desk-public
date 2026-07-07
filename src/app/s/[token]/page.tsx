import { headers } from "next/headers";
import { after } from "next/server";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Markdown from "@/components/Markdown";
import SandboxedHtml from "@/components/SandboxedHtml";
import {
  resolveShare,
  resolveDirectoryShare,
  listDocsUnderShare,
  resolveShareState,
} from "@/lib/shares";
import { listComments } from "@/lib/comments";
import { loadShareView, formatStamp, excerptFrom, type ShareView } from "./load-share";
import ShareComments from "./ShareComments";
import SuggestEdit from "./SuggestEdit";
import ReaderActions from "./ReaderActions";
import DirectoryIndex from "./DirectoryIndex";
import { MD_READER_WIDTH, HTML_READER_WIDTH } from "./reader-width";
import type { CommentDTO } from "@/app/(hub)/docs/[slug]/comments-view-model";

// Every request must resolve the share fresh — revocation / expiry / unpublish
// must take effect immediately, with no caching layer in front. (§ self-review:
// revoke-then-reload must 404.)
export const dynamic = "force-dynamic";

// ── metadata ──────────────────────────────────────────────────────────────────
// Title leaks only the doc title (which the holder of the link can already see);
// description stays neutral so an unfurled link reveals no document content.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const resolved = await resolveShare(token);

  if (resolved !== null) {
    const excerpt = resolved.version
      ? excerptFrom(resolved.version.content)
      : undefined;
    return {
      title: resolved.doc.title,
      description: excerpt || "Shared document",
      openGraph: {
        title: resolved.doc.title,
        description: excerpt || "Shared document",
        type: "article",
      },
      twitter: { card: "summary" },
    };
  }

  // Directory share? Leak only the folder name (the link holder already knows it).
  const dir = await resolveDirectoryShare(token);
  if (dir !== null) {
    return {
      title: `Folder: ${dir.pathPrefix}`,
      description: "Shared folder",
      openGraph: {
        title: `Folder: ${dir.pathPrefix}`,
        description: "Shared folder",
        type: "article",
      },
      twitter: { card: "summary" },
    };
  }

  // Dead link (expired/revoked/unknown) — neutral, no content leak
  return {
    title: "Desk",
    description: "Shared document",
  };
}

// ── helper: first IP from x-forwarded-for ─────────────────────────────────────
function firstForwardedIp(xff: string | null): string | undefined {
  if (!xff) return undefined;
  const first = xff.split(",")[0]?.trim();
  return first ? first : undefined;
}

// ── page ──────────────────────────────────────────────────────────────────────
export default async function SharePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const h = await headers();
  const ip = firstForwardedIp(h.get("x-forwarded-for"));
  const userAgent = h.get("user-agent") ?? undefined;

  // Thin shell over loadShareView: it resolves the share (uniform null on every
  // failure cause) and records the view. We pass `after` as the scheduler so the
  // recordView insert runs post-response and never lengthens the render path
  // (see load-share.ts). null → uniform 404.
  const view = await loadShareView(token, {
    ip,
    userAgent,
    schedule: (task) => after(task),
  });
  if (view === null) {
    // Not a doc share — try a directory share and render its index. The index
    // records no view (views are recorded on per-doc open, per spec). null here
    // means truly unknown/revoked/expired → uniform 404.
    const dir = await resolveDirectoryShare(token);
    if (dir === null) {
      // Distinguish expired links from fully gone ones for a friendlier UX.
      const stateResult = await resolveShareState(token);
      if (stateResult.state === "expired") {
        return <ExpiredSharePage expiresAt={stateResult.expiresAt} />;
      }
      notFound();
    }

    const docs = await listDocsUnderShare(dir.shareId);
    const expiresSoon =
      dir.expiresAt !== null &&
      dir.expiresAt.getTime() - Date.now() < 7 * 24 * 60 * 60 * 1000;
    return (
      <DirectoryIndex
        token={token}
        pathPrefix={dir.pathPrefix}
        createdBy={dir.createdBy}
        docs={docs}
        expiresSoon={expiresSoon}
        expiresStamp={dir.expiresAt ? formatStamp(dir.expiresAt) : null}
      />
    );
  }

  // Load the visible (unresolved) thread when this share permits comments. We
  // re-resolve to get the doc id — cheap under force-dynamic, and keeps the
  // ShareView contract (no doc internals) intact. resolveShare can't be null
  // here (loadShareView just succeeded), but guard defensively.
  let comments: CommentDTO[] = [];
  if (view.allowComments) {
    const resolved = await resolveShare(token);
    if (resolved !== null) {
      const rows = await listComments(resolved.doc.id, { includeResolved: false });
      comments = rows.map((c) => ({
        id: c.id,
        authorName: c.authorName,
        authorKind: c.authorKind,
        body: c.body,
        createdAt: c.createdAt.toISOString(),
      }));
    }
  }

  const commentsNode = view.allowComments ? (
    <>
      <div
        style={{
          maxWidth: view.kind === "html" ? HTML_READER_WIDTH : MD_READER_WIDTH,
          margin: "0 auto",
          borderTop: "1px solid var(--hairline)",
        }}
      />
      <ShareComments token={view.token} label={view.shareLabel} initial={comments} />
    </>
  ) : null;

  // "Suggest an edit" is md-only (html has no editor) and gated on the share's
  // allow_edits flag — independent of allowComments.
  const suggestNode =
    view.kind === "md" && view.allowEdits ? (
      <>
        <div
          style={{
            maxWidth: MD_READER_WIDTH,
            margin: "0 auto",
            borderTop: "1px solid var(--hairline)",
          }}
        />
        <SuggestEdit token={view.token} label={view.shareLabel} source={view.content} />
      </>
    ) : null;

  if (view.kind === "html") {
    return <HtmlArtifact view={view} comments={commentsNode} />;
  }

  return <MdDoc view={view} comments={commentsNode} suggest={suggestNode} />;
}

// ── expired share page ─────────────────────────────────────────────────────────
function ExpiredSharePage({ expiresAt }: { expiresAt: Date }) {
  const stamp = formatStamp(expiresAt);
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        fontFamily: "var(--font-sans)",
      }}
    >
      <div
        style={{
          maxWidth: 460,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 40, marginBottom: 16, color: "var(--muted)" }}>
          🔒
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: "0 0 12px" }}>
          This link has expired
        </h1>
        <p style={{ fontSize: 15, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 8px" }}>
          This link expired on <strong>{stamp}</strong>.
        </p>
        <p style={{ fontSize: 14, color: "var(--faint)", lineHeight: 1.6, margin: 0 }}>
          Contact whoever shared it to get a fresh link.
        </p>
      </div>
    </div>
  );
}

// ── expiring banner ───────────────────────────────────────────────────────────
function ExpiringBanner({ stamp, createdBy }: { stamp: string; createdBy: string }) {
  return (
    <div
      style={{
        background: "var(--warn-bg)",
        borderBottom: "1px solid var(--warn-border)",
      }}
    >
      <div
        style={{
          maxWidth: MD_READER_WIDTH,
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
          This link expires {stamp}. Ask {createdBy} for a fresh one if you need
          it longer.
        </span>
      </div>
    </div>
  );
}

// ── minimal header (title + updated stamp) ────────────────────────────────────
function MinimalHeader({
  title,
  updatedStamp,
  createdBy,
  actions,
  maxWidth = MD_READER_WIDTH,
}: {
  title: string;
  updatedStamp: string;
  createdBy: string;
  /** Quiet right-aligned actions (Copy / Download), rendered under the stamp. */
  actions?: React.ReactNode;
  maxWidth?: number;
}) {
  return (
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
          padding: "14px 24px",
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
            // Let the title shrink so the actions never get pushed off-screen on
            // a 390px viewport — it ellipsizes rather than crowding.
            minWidth: 0,
          }}
        >
          {title}
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
            Updated {updatedStamp} · shared by {createdBy}
          </span>
          {actions}
        </span>
      </div>
    </header>
  );
}

// ── footer (social deterrent) ─────────────────────────────────────────────────
function ShareFooter({ createdBy }: { createdBy: string }) {
  return (
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
        Private link · shared by {createdBy} · do not forward
      </span>
    </footer>
  );
}

// ── md doc render ─────────────────────────────────────────────────────────────
function MdDoc({
  view,
  comments,
  suggest,
}: {
  view: ShareView;
  comments?: React.ReactNode;
  suggest?: React.ReactNode;
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
      {view.expiresSoon && view.expiresStamp && (
        <ExpiringBanner stamp={view.expiresStamp} createdBy={view.createdBy} />
      )}

      <MinimalHeader
        title={view.title}
        updatedStamp={view.updatedStamp}
        createdBy={view.createdBy}
        actions={<ReaderActions token={view.token} source={view.content} />}
      />

      <article
        style={{
          maxWidth: MD_READER_WIDTH,
          margin: "0 auto",
          padding: "56px 24px 40px",
        }}
      >
        <Markdown content={view.content} register="partner" />
        <ShareFooter createdBy={view.createdBy} />
      </article>

      {/* "Suggest an edit" affordance BELOW the footer divider (md + edits-on). */}
      {suggest}

      {/* Comment thread + composer BELOW the footer divider (only when allowed). */}
      {comments}
    </div>
  );
}

// ── html artifact render (sandboxed iframe) ───────────────────────────────────
function HtmlArtifact({ view, comments }: { view: ShareView; comments?: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--ink)",
      }}
    >
      {view.expiresSoon && view.expiresStamp && (
        <ExpiringBanner stamp={view.expiresStamp} createdBy={view.createdBy} />
      )}

      <MinimalHeader
        title={view.title}
        updatedStamp={view.updatedStamp}
        createdBy={view.createdBy}
        actions={<ReaderActions token={view.token} source={view.content} />}
        maxWidth={HTML_READER_WIDTH}
      />

      <div style={{ flex: 1, display: "flex" }}>
        {/* Sandbox policy lives in SandboxedHtml (allow-scripts only, opaque
            origin). The hub viewer renders through the same component. */}
        <SandboxedHtml
          content={view.content}
          title={view.title}
          style={{ flex: 1, minHeight: "85vh" }}
        />
      </div>

      {/* Comment thread + composer below the artifact (only when allowed). */}
      {comments && <div style={{ marginTop: 40 }}>{comments}</div>}
    </div>
  );
}
