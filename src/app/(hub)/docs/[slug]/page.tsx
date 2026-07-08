import { headers } from "next/headers";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrincipal } from "@/lib/auth";
import { getDocBySlug, listVersions, getVersionContent, listDocs, scopeForPrincipal } from "@/lib/docs";
import { docPreviewDescription } from "@/lib/preview";
import { canPublishVersion } from "@/lib/permissions";
import { getUserById } from "@/lib/users";
import { unifiedDiff } from "@/lib/diff";
import Markdown from "@/components/Markdown";
import HtmlPreview from "./HtmlPreview";
import DriftBanner from "@/components/DriftBanner";
import { getSpaceById, ownerHandleForSpace } from "@/lib/spaces";
import DocActions from "./DocActions";
import DocReaderActions from "./DocReaderActions";
import DocSharingPanel from "./DocSharingPanel";
import Comments from "./Comments";
import { listComments } from "@/lib/comments";
import type { CommentDTO } from "./comments-view-model";
import Revisions, { type RevisionViewData } from "./Revisions";
import { listRevisions } from "@/lib/revisions";
import type { RevisionDTO } from "./revisions-view-model";
import {
  shortHash,
  dateStamp,
  buildVersionRail,
  predecessorVersionId,
  parseDiffParam,
  deriveFolders,
} from "../view-model";

export const dynamic = "force-dynamic";

/**
 * Link-preview metadata (Open Graph / Twitter) for the hub doc viewer.
 *
 * SECURITY: resolves the doc through the SAME access-scoped `getDocBySlug` the
 * page uses (admin/member scope + published gate). A doc the caller can't see —
 * or that doesn't exist — yields neutral default metadata and NEVER emits the
 * doc's title or description, so OG tags cannot leak a private doc's title.
 * This mirrors the page's own `notFound()` branch (uniform, no existence signal).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const principal = await getPrincipal(await headers());
  const result = await getDocBySlug(slug, {
    includeUnpublished: principal.kind === "admin",
    scope: await scopeForPrincipal(principal),
  });
  // Not visible / not found → neutral, leak-free default (no title, no description).
  if (!result) return { title: "Desk" };

  const title = result.doc.title;
  const description = docPreviewDescription(result.doc);
  return {
    title,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

const diffColors = {
  ctx: { bg: "transparent", fg: "var(--muted)" },
  add: { bg: "var(--diff-add-bg)", fg: "var(--diff-add-fg)" },
  del: { bg: "var(--diff-del-bg)", fg: "var(--diff-del-fg)" },
} as const;

export default async function DocDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ diff?: string | string[]; proposed?: string }>;
}) {
  const [{ slug }, { diff, proposed }, principal] = await Promise.all([
    params,
    searchParams,
    getPrincipal(await headers()),
  ]);

  const isAdmin = principal.kind === "admin";

  // Service layer handles audience scoping via scope option; null = not found
  // or audience-denied (indistinguishable — no existence signal leaks to members).
  // Layout gates anonymous; viewer is always admin | member here.
  const result = await getDocBySlug(slug, {
    includeUnpublished: isAdmin,
    scope: await scopeForPrincipal(principal),
  });
  if (!result) notFound();

  const { doc, version } = result;
  // The doc lives in a space; the back-link returns there (Gen-2: Spaces is the
  // home, there is no flat /docs list). Fall back to /spaces if the space is gone.
  const space = await getSpaceById(doc.spaceId);
  // Owner-qualified space URL (Owner-namespace S4): /spaces/<owner-handle>/<slug>.
  const spaceHref = space
    ? `/spaces/${await ownerHandleForSpace(space)}/${space.slug}`
    : "/spaces";
  const backHref = spaceHref;
  const versions = await listVersions(slug);
  const rail = buildVersionRail(versions);
  // Serializable version options for the share modal's live-vs-pinned picker.
  const shareVersionOptions = rail.map((v) => ({ id: v.id, label: v.label }));
  // version id → bare "vN" (e.g. "v5"), for the pinned share mode chip.
  const versionLabelById: Record<number, string> = Object.fromEntries(
    rail.map((v) => [v.id, v.label.match(/^v\d+/)?.[0] ?? v.label]),
  );
  // Folder set for the Move picker (admin-only action) — derived from all docs
  // (incl. unpublished, so admins can move into any existing folder).
  const moveFolders = isAdmin
    ? deriveFolders(await listDocs({ includeUnpublished: true, scope: { viewer: "admin" } }))
    : [];

  // Ownership + publish permission.
  const canPublishDirect = canPublishVersion(principal, doc);
  // Resolve owner display name for the doc header meta.
  const ownerDisplayName = doc.ownerUserId
    ? ((await getUserById(doc.ownerUserId))?.displayName ?? null)
    : null;

  // Full thread (staff see resolved too). Serialize to the wire DTO the island
  // expects (createdAt/resolvedAt as ISO strings).
  const commentRows = await listComments(doc.id, { includeResolved: true });
  const initialComments: CommentDTO[] = commentRows.map((c) => ({
    id: c.id,
    authorName: c.authorName,
    authorKind: c.authorKind,
    body: c.body,
    createdAt: c.createdAt.toISOString(),
    resolvedAt: c.resolvedAt ? c.resolvedAt.toISOString() : null,
  }));

  // ── proposed revisions ────────────────────────────────────────────────────────
  // Build the diff(s) server-side so the island stays presentational: every
  // revision gets a base→proposed diff; a stale-base revision also gets a
  // current→proposed diff. md docs only (html docs have no editor).
  const canEdit = doc.format === "md" && version !== null;
  let revisionData: RevisionViewData[] = [];
  if (canEdit) {
    const revRows = await listRevisions(doc.id);
    const currentContent = version!.content;
    revisionData = await Promise.all(
      revRows.map(async (r) => {
        const baseContent = (await getVersionContent(slug, r.baseVersionId)) ?? "";
        const staleBase = r.baseVersionId !== doc.currentVersionId;
        const dto: RevisionDTO = {
          id: r.id,
          baseVersionId: r.baseVersionId,
          authorName: r.authorName,
          authorKind: r.authorKind,
          note: r.note,
          status: r.status as RevisionDTO["status"],
          createdAt: r.createdAt.toISOString(),
          decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
          proposerLabel: r.proposerLabel,
        };
        return {
          rev: dto,
          diff: unifiedDiff(baseContent, r.content),
          staleBase,
          diffVsCurrent: staleBase ? unifiedDiff(currentContent, r.content) : null,
        };
      }),
    );
  }

  // ── diff (optional) ──────────────────────────────────────────────────────────
  const selectedDiffId = parseDiffParam(diff);
  let diffView: {
    fromLabel: string;
    toLabel: string;
    lines: ReturnType<typeof unifiedDiff>;
  } | null = null;

  if (selectedDiffId !== null) {
    const prevId = predecessorVersionId(versions, selectedDiffId);
    if (prevId !== null) {
      const [newContent, oldContent] = await Promise.all([
        getVersionContent(slug, selectedDiffId),
        getVersionContent(slug, prevId),
      ]);
      if (newContent !== null && oldContent !== null) {
        const selIdx = versions.findIndex((v) => v.id === selectedDiffId);
        const prevIdx = versions.findIndex((v) => v.id === prevId);
        diffView = {
          fromLabel: `v${versions.length - prevIdx} (${dateStamp(versions[prevIdx].publishedAt)})`,
          toLabel: `v${versions.length - selIdx} (${dateStamp(versions[selIdx].publishedAt)})`,
          lines: unifiedDiff(oldContent, newContent),
        };
      }
    }
  }

  const currentHash = version?.contentHash ?? "";

  return (
    <div
      style={{
        maxWidth: 1060,
        margin: "0 auto",
        padding: "26px 20px 80px",
        display: "flex",
        gap: 36,
        alignItems: "flex-start",
      }}
    >
      <article style={{ flex: 1, minWidth: 0 }}>
        <Link
          href={backHref}
          style={{
            fontSize: 12.5,
            color: "var(--muted)",
            textDecoration: "none",
            display: "inline-block",
            marginBottom: 16,
          }}
        >
          ← {space ? space.slug : "Spaces"}
        </Link>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            marginBottom: 8,
          }}
        >
          <h1 style={{ fontSize: 24, fontWeight: 600, letterSpacing: "-0.015em", margin: 0 }}>
            {doc.title}
          </h1>
          {space && (
            <Link
              href={spaceHref}
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 999,
                border: "1px solid var(--hairline)",
                background: "var(--surface-alt)",
                color: "var(--muted)",
                textDecoration: "none",
              }}
            >
              {space.slug}
            </Link>
          )}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--faint)",
            marginBottom: 20,
            flexWrap: "wrap",
          }}
        >
          <span>{doc.slug}</span>
          <span>source {doc.sourcePath}</span>
          <span>folder {doc.path === "" ? "—" : doc.path}</span>
          {currentHash && <span>hash {shortHash(currentHash)}</span>}
        </div>

        {/* Action cluster — admin sees full cluster (Share · Edit · ⋯ overflow);
            member sees Share · Propose edit (when canEdit) + a one-line note.
            Rendered for all staff; DocActions handles the isAdmin branch. */}
        <DocActions
          slug={doc.slug}
          title={doc.title}
          path={doc.path}
          isPublished={doc.unpublishedAt === null}
          isAdmin={isAdmin}
          canEdit={canEdit}
          canPublishDirect={canPublishDirect}
          ownerDisplayName={ownerDisplayName}
          versions={shareVersionOptions}
          folders={moveFolders}
          versionCount={rail.length}
        />

        {proposed === "1" && (
          <div
            style={{
              border: "1px solid var(--accent)",
              background: "var(--accent-ring)",
              borderRadius: 8,
              padding: "10px 14px",
              marginBottom: 20,
              fontSize: 13,
              color: "var(--accent)",
            }}
          >
            Edit proposed — it&rsquo;s queued below for an admin to review.
          </div>
        )}

        {doc.unpublishedAt !== null && (
          <DriftBanner label="unpublished">
            This doc is unpublished — its share links now 404. Re-publish from the
            repo to make it visible again.
          </DriftBanner>
        )}

        {diffView && (
          <div
            style={{
              border: "1px solid var(--hairline)",
              borderRadius: 10,
              overflow: "hidden",
              marginBottom: 24,
            }}
          >
            <div
              style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--hairline)",
                background: "var(--surface-alt)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  color: "var(--muted)",
                }}
              >
                diff · {diffView.fromLabel} → {diffView.toLabel}
              </span>
              <Link
                href={`/docs/${doc.slug}`}
                style={{ fontSize: 12, color: "var(--muted)", textDecoration: "none" }}
              >
                Close diff
              </Link>
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.7,
                padding: "12px 0",
              }}
            >
              {diffView.lines.map((line, i) => {
                const c = diffColors[line.type];
                const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
                return (
                  <div
                    key={i}
                    style={{
                      padding: "1px 16px",
                      background: c.bg,
                      color: c.fg,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {sign} {line.text}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {version ? (
          doc.format === "html" ? (
            <HtmlPreview content={version.content} title={doc.title} />
          ) : (
            <Markdown content={version.content} register="operator" />
          )
        ) : (
          <p style={{ color: "var(--muted)", fontSize: 13.5 }}>
            This doc has no published version yet.
          </p>
        )}

        {/* Copy + Download the current version's source — staff affordance, built
            client-side from the content already on the page (no new route). */}
        {version && (
          <div style={{ marginTop: 20 }}>
            <DocReaderActions
              slug={doc.slug}
              source={version.content}
              format={doc.format}
            />
          </div>
        )}

        {/* Sharing panel: the per-doc capability share-links table. Visibility is
            space-scoped now (set on the space), so there is no per-doc audience
            control here. Members see the read-only links view. */}
        <DocSharingPanel
          slug={doc.slug}
          isAdmin={isAdmin}
          versions={shareVersionOptions}
          versionLabelById={versionLabelById}
        />

        {/* Proposed revisions — staff propose; admins accept/reject. Only on
            editable (markdown + published) docs. Hidden entirely when there are
            no revisions and the viewer can't propose (handled inside via the
            empty state). */}
        {canEdit && revisionData.length > 0 && (
          <Revisions
            slug={doc.slug}
            isAdmin={isAdmin}
            data={revisionData}
            isMirrored={space?.sourceMode === "mirrored"}
          />
        )}

        {/* Comment thread — only meaningful once the doc has a version to anchor
            comments against (the composer POSTs against the current version). */}
        {version && (
          <Comments slug={doc.slug} isAdmin={isAdmin} initial={initialComments} />
        )}
      </article>

      <aside id="version-rail" style={{ width: 240, flex: "none", position: "sticky", top: 76 }}>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--faint)",
            marginBottom: 10,
          }}
        >
          Versions
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {rail.map((v) => (
            <div
              key={v.id}
              style={{
                padding: "10px 12px",
                borderLeft: `2px solid ${v.isCurrent ? "var(--accent)" : "var(--hairline)"}`,
                marginBottom: 2,
                background: v.isCurrent ? "var(--surface-alt)" : "transparent",
                borderRadius: "0 8px 8px 0",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                    fontWeight: 600,
                    color: v.isCurrent ? "var(--accent)" : "var(--muted)",
                  }}
                >
                  {v.label}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10.5,
                    color: "var(--faint)",
                  }}
                >
                  {v.date}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 3 }}>
                published by {v.publisher}
              </div>
              {v.diffable && (
                <Link
                  href={`/docs/${doc.slug}?diff=${v.id}`}
                  style={{
                    display: "inline-block",
                    marginTop: 6,
                    fontSize: 11,
                    fontWeight: 500,
                    color: "var(--accent)",
                    textDecoration: "none",
                  }}
                >
                  View diff vs previous
                </Link>
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
