import type { ShareVersionOption } from "@/components/ShareModal";
import DocShareLinks from "./DocShareLinks";

/**
 * "Sharing" panel for the doc page.
 *
 * Read visibility is space-scoped now (Gen-2 consolidation) — a doc is visible
 * to the members of its space (or anyone, if the space is public/unlisted), set
 * on the space itself. There is no per-doc audience control here. This panel is
 * just the per-doc CAPABILITY share-links table + New link (a one-off external
 * read door), embedded headless. Members see the read-only links view.
 */
export default async function DocSharingPanel({
  slug,
  isAdmin,
  versions,
  versionLabelById = {},
}: {
  slug: string;
  isAdmin: boolean;
  versions?: ShareVersionOption[];
  versionLabelById?: Record<number, string>;
}) {
  return (
    <section style={{ marginTop: 36, marginBottom: 8 }}>
      <h2
        style={{
          fontSize: 13,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          margin: "0 0 12px",
        }}
      >
        Sharing
      </h2>

      <DocShareLinks
        slug={slug}
        isAdmin={isAdmin}
        versions={versions}
        versionLabelById={versionLabelById}
        embedded
      />
    </section>
  );
}
