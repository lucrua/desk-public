/**
 * Legacy single-slug space-URL resolution (Owner-namespace S4, decision D5).
 *
 * Before S4 spaces resolved by a globally-unique slug: `/spaces/<slug>` (web) and
 * `/api/spaces/<slug>/…` (API). S4 makes the canonical shape owner-qualified
 * (`/spaces/<owner>/<slug>`, `/api/spaces/<owner>/<slug>/…`) so two owners can share
 * a slug. The old single-segment links must keep working during the deprecation
 * window — this module computes what the proxy should do with a legacy-shaped path:
 *
 *   - **Web** `/spaces/<slug>` (one segment): resolve the slug → a UNIQUE owner →
 *     **301 redirect** to `/spaces/<handle>/<slug>` (a redirect is safe — web nav is
 *     GET; it preserves every existing bookmark, e.g. the external `/spaces/growth-
 *     reports`). Ambiguous / unknown → `pass` (Next renders its natural 404).
 *   - **API** `/api/spaces/<slug>[/<subresource>…]`: a redirect would drop a POST
 *     body, so resolve the slug → owner handle and **rewrite in place** to
 *     `/api/spaces/<handle>/<slug>/…` (NextResponse.rewrite preserves method +
 *     body). Ambiguous → **409** ("qualify with <owner>/<slug>"). Unknown → `pass`.
 *
 * Canonical requests never reach a DB lookup here: a 2-segment web path, or an API
 * path whose second segment is NOT a reserved sub-resource word, is `pass`-ed
 * structurally. Only legacy-SHAPED paths (a bare slug, or `<slug>/<reserved>`) do a
 * lookup — and among those the reserved-word ambiguity (a space literally named
 * `docs`/`members`/…) is disambiguated by a cheap handle check: if the first
 * segment is a known handle, it's canonical and passes through.
 *
 * The proxy calls `planSpaceRoute(pathname)` and applies the returned directive.
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { spaces, users } from "@/db/schema";

/**
 * The sub-resource segment names that can follow a space in the API. Used to
 * detect the LEGACY single-slug API shape (`/api/spaces/<slug>/<reserved>`) without
 * a DB hit on the canonical hot path. KEEP IN SYNC with the route directories under
 * `src/app/api/spaces/[owner]/[slug]/`.
 */
export const SPACE_SUBRESOURCES: ReadonlySet<string> = new Set([
  "docs",
  "invites",
  "members",
  "mirror",
  "proposals",
  "raw",
  "reindex",
]);

export type SpaceRoutePlan =
  | { kind: "pass" }
  | { kind: "redirect"; location: string } // web legacy, unique slug → 301
  | { kind: "rewrite"; pathname: string } // api legacy, unique slug → rewrite in place
  | { kind: "conflict" }; // api legacy, ambiguous slug → 409

/** Is `seg` a known user handle? (handles are stored lowercased; match case-insensitively.) */
async function isKnownHandle(seg: string): Promise<boolean> {
  const h = seg.trim().toLowerCase();
  if (h.length === 0) return false;
  const row = await db.query.users.findFirst({ where: eq(users.handle, h) });
  return row != null;
}

type SlugOwner =
  | { status: "ok"; handle: string }
  | { status: "none" }
  | { status: "ambiguous" };

/**
 * Resolve a bare slug to its owner's handle so a legacy URL can be rewritten to the
 * owner-qualified path. Fail-closed: an owner without a handle (a pre-backfill row)
 * counts as unresolvable (`none`).
 */
async function resolveSlugOwner(slug: string): Promise<SlugOwner> {
  const rows = await db
    .select({ handle: users.handle })
    .from(spaces)
    .innerJoin(users, eq(users.id, spaces.ownerUserId))
    .where(eq(spaces.slug, slug))
    .limit(2);
  if (rows.length === 0) return { status: "none" };
  if (rows.length > 1) return { status: "ambiguous" };
  const handle = rows[0].handle;
  if (!handle) return { status: "none" };
  return { status: "ok", handle };
}

function segments(rest: string): string[] {
  return rest.split("/").filter((s) => s.length > 0);
}

/**
 * Decide what the proxy should do with a possibly-legacy space path. Returns
 * `{ kind: "pass" }` for anything that is already canonical (or unrelated), a
 * redirect/rewrite for a resolvable legacy slug, or a conflict for an ambiguous one.
 */
export async function planSpaceRoute(pathname: string): Promise<SpaceRoutePlan> {
  // ── WEB: /spaces/<slug> (exactly one segment) → 301 to /spaces/<handle>/<slug>.
  if (pathname === "/spaces" || pathname.startsWith("/spaces/")) {
    const segs = segments(pathname.slice("/spaces".length));
    // 0 segments = the /spaces list; 2+ = canonical /spaces/<owner>/<slug> — both pass.
    if (segs.length !== 1) return { kind: "pass" };
    const slug = decodeURIComponent(segs[0]);
    const r = await resolveSlugOwner(slug);
    if (r.status === "ok") {
      return { kind: "redirect", location: `/spaces/${r.handle}/${segs[0]}` };
    }
    // Ambiguous or unknown → let Next render its natural 404 (no 1-segment route).
    return { kind: "pass" };
  }

  // ── API: /api/spaces/<slug>[/<subresource>…] → rewrite in place to owner-qualified.
  if (pathname.startsWith("/api/spaces/")) {
    const rest = pathname.slice("/api/spaces/".length);
    const segs = segments(rest);
    if (segs.length === 0) return { kind: "pass" }; // /api/spaces/  (collection)

    // Structural pre-filter (no DB on the canonical hot path): a bare slug, or
    // `<slug>/<reserved>`. Anything else — including canonical `<owner>/<slug>` and
    // `<owner>/<slug>/<reserved>` — passes through untouched.
    const legacyShaped =
      segs.length === 1 || (segs.length >= 2 && SPACE_SUBRESOURCES.has(segs[1]));
    if (!legacyShaped) return { kind: "pass" };

    // Disambiguate the reserved-word edge (a space literally named `docs`/`members`/…
    // reached at its canonical root `/api/spaces/<owner>/docs`): if the first segment
    // is a known handle, this is canonical → pass.
    if (segs.length >= 2 && (await isKnownHandle(decodeURIComponent(segs[0])))) {
      return { kind: "pass" };
    }

    const r = await resolveSlugOwner(decodeURIComponent(segs[0]));
    if (r.status === "ok") {
      return { kind: "rewrite", pathname: `/api/spaces/${r.handle}/${rest}` };
    }
    if (r.status === "ambiguous") return { kind: "conflict" };
    return { kind: "pass" }; // unknown slug → natural 404
  }

  return { kind: "pass" };
}
