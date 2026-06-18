import type { ShareVersionOption } from "@/components/ShareModal";
import { listAudiences, listAllMemberships } from "@/lib/audiences";
import DocShareLinks from "./DocShareLinks";
import DocVisibilityControl, { type AudienceChoice } from "./DocVisibilityControl";

/**
 * Consolidated "Sharing" panel for the doc page (Audiences v2).
 *
 * One section that combines:
 *   1. the visibility control — audience <select> + live "Visible to:" preview
 *      (admin only; computed from the audience's member_visible flag + its
 *      group membership), and
 *   2. the existing per-doc share-links table + New link (embedded, headless).
 *
 * Members keep the read-only links view (no visibility control). The separate
 * audience badge in the page header is unchanged.
 */
export default async function DocSharingPanel({
  slug,
  audience,
  isAdmin,
  versions,
  versionLabelById = {},
}: {
  slug: string;
  audience: string;
  isAdmin: boolean;
  versions?: ShareVersionOption[];
  versionLabelById?: Record<number, string>;
}) {
  // Build the audience choices (admin only — the visibility control). Each
  // choice carries its member-visible flag + the display names of its members so
  // the preview line can read "all members" / "only you" / "you + Bob".
  let choices: AudienceChoice[] = [];
  if (isAdmin) {
    const [audiences, memberships] = await Promise.all([
      listAudiences(),
      listAllMemberships(),
    ]);
    const namesByAudience = new Map<number, string[]>();
    for (const m of memberships) {
      const arr = namesByAudience.get(m.audienceId) ?? [];
      arr.push(m.displayName);
      namesByAudience.set(m.audienceId, arr);
    }
    choices = audiences.map((a) => ({
      key: a.key,
      label: a.label,
      memberVisible: a.memberVisible,
      memberNames: namesByAudience.get(a.id) ?? [],
    }));
  }

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

      {isAdmin && (
        <DocVisibilityControl slug={slug} currentAudience={audience} choices={choices} />
      )}

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
