-- 0013_lifecycle_distribution
-- Adds:
--   shares.token_enc  — AES-256-GCM ciphertext of the raw token (nullable;
--                        pre-migration rows keep only the hash and can't reveal).
--   shares.deleted_at — stage-2 tombstone for share links (soft delete).
--   docs.deleted_at   — stage-2 tombstone for docs (soft delete + content purge).
--   Replaces the plain-unique docs_slug_idx with a PARTIAL unique index
--   (WHERE deleted_at IS NULL) so a deleted doc's slug can be reused.
--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "token_enc" text;
--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "deleted_at" timestamp;
--> statement-breakpoint
-- Drop the old non-partial unique index on docs.slug.
DROP INDEX IF EXISTS "docs_slug_idx";
--> statement-breakpoint
-- Recreate as a PARTIAL unique index: only one LIVE (deleted_at IS NULL)
-- doc may hold a given slug at any time. Deleted rows are excluded, freeing
-- the slug for a brand-new doc.
CREATE UNIQUE INDEX "docs_slug_idx" ON "docs" ("slug") WHERE "deleted_at" IS NULL;
