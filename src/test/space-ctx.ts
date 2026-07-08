/**
 * Owner-qualified route-handler context builder for tests (Owner-namespace S4).
 *
 * The space API routes moved from `[slug]` to `[owner]/[slug]`, so their handlers
 * now receive `params: { owner, slug, … }` and resolve via `getSpace(owner, slug)`.
 * Route tests call the handlers DIRECTLY (bypassing the proxy that rewrites legacy
 * single-slug URLs), so they must pass a valid owner HANDLE in the ctx.
 *
 * `spaceCtx(slug, extra?)` builds `{ params }` where `params` is a promise that
 * resolves the space's owner handle from the DB (the space is seeded before the
 * ctx is used). For an UNKNOWN slug it falls back to a placeholder handle, so
 * "unknown space → 404" tests still exercise the not-found path (getSpace with an
 * owner/slug that resolves to nothing → null → 404).
 */
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { spaces, users } from "@/db/schema";

const NO_OWNER = "no-such-owner";

async function ownerHandleForSlug(slug: string): Promise<string> {
  const [space] = await db.select().from(spaces).where(eq(spaces.slug, slug)).limit(1);
  if (!space) return NO_OWNER;
  const owner = await db.query.users.findFirst({ where: eq(users.id, space.ownerUserId) });
  return owner?.handle ?? NO_OWNER;
}

/**
 * Build a route ctx `{ params }` for a space slug, owner-qualified. Extra params
 * (e.g. `{ name }` for proposals, `{ path }` for raw) are merged into the params.
 */
export function spaceCtx<E extends Record<string, unknown> = Record<string, never>>(
  slug: string,
  extra?: E,
): { params: Promise<{ owner: string; slug: string } & E> } {
  return {
    params: (async () => ({
      owner: await ownerHandleForSlug(slug),
      slug,
      ...(extra ?? ({} as E)),
    }))(),
  };
}
