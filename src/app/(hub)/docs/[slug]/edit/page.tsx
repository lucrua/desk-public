import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPrincipal, isStaff } from "@/lib/auth";
import { getDocBySlug, scopeForPrincipal } from "@/lib/docs";
import { canPublishVersion } from "@/lib/permissions";
import EditorLoader from "./EditorLoader";

export const dynamic = "force-dynamic";

/**
 * Propose-edit route. Staff-only, space-scoped, markdown docs only.
 *
 * Gating mirrors the doc page + the revisions API: a member on a doc in a space
 * they can't see gets a uniform notFound() (no existence leak); an html doc or an
 * anonymous visitor also 404s (anonymous is gated at the hub layout, but we
 * defend here too). The editor itself is a lazy-loaded client island.
 */
export default async function DocEditPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, principal] = await Promise.all([params, getPrincipal(await headers())]);

  if (!isStaff(principal)) notFound();
  const viewer = principal.kind;

  const result = await getDocBySlug(slug, {
    includeUnpublished: viewer === "admin",
    scope: await scopeForPrincipal(principal),
  });
  if (!result) notFound();

  const { doc, version } = result;
  // html docs have no editor; a doc with no published version can't be edited.
  if (doc.format !== "md" || version === null) notFound();

  // Whether this principal can publish directly (skip approval queue).
  const canPublishDirect = canPublishVersion(principal, doc);

  return (
    <div style={{ maxWidth: 1060, margin: "0 auto", padding: "26px 20px 80px" }}>
      <Link
        href={`/docs/${doc.slug}`}
        style={{
          fontSize: 12.5,
          color: "var(--muted)",
          textDecoration: "none",
          display: "inline-block",
          marginBottom: 16,
        }}
      >
        ← Back to doc
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
        <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-0.015em", margin: 0 }}>
          {canPublishDirect ? "Edit" : "Propose edit"} · {doc.title}
        </h1>
      </div>

      <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 20px", lineHeight: 1.6 }}>
        {canPublishDirect
          ? "Saving publishes a new version immediately — readers see it right away."
          : "Readers keep seeing the published version. Your edit queues as a proposed revision for an admin to review and accept."}
      </p>

      <EditorLoader slug={doc.slug} initialContent={version.content} canPublishDirect={canPublishDirect} />
    </div>
  );
}
