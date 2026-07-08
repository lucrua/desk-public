-- 0023_user_handle
-- Owner-namespace, Slice S1 (decision D1): a stable, unique, URL-safe user handle.
--
-- `users.handle` is the REAL owner identity later slices (S2+) use for the
-- on-disk repo path and owner-namespaced URLs, REPLACING the broken email-derived
-- ownerSlugForUser (recomputed live from the mutable users.email — not unique
-- across two `lucas@…` accounts, not stable when the primary email is repointed).
-- Format ^[a-z0-9][a-z0-9-]*$, length ≤ 39.
--
-- Added NULLABLE (not NOT NULL yet): Postgres allows MULTIPLE NULLs under a
-- UNIQUE index, so existing rows can sit at NULL until the idempotent boot
-- backfill (backfillUserHandles, wired into instrumentation.register after the
-- existing backfills) assigns each one deterministically (id ascending;
-- tokenName/email-local/`u<id>` → slugify → de-dup with a `-N` suffix). Going
-- forward every user-creation path assigns a handle, so NULLs exist only
-- transiently pre-backfill. A follow-up may enforce NOT NULL once every
-- deployment is backfilled.
ALTER TABLE "users" ADD COLUMN "handle" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_handle_idx" ON "users" USING btree ("handle");
