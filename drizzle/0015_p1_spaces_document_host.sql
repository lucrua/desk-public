-- 0015_p1_spaces_document_host
-- Phase-1 document host (specs/desk/design-document-host.md §14).
--
-- Adds the SPACE abstraction (the owned, access-controlled git repo Desk hosts —
-- the WRITE/clone security boundary), space membership (the coarse ACL the git
-- transport gates on), principal tokens (the git Basic-auth credential), and the
-- projection columns that turn `docs` into an index of repo files.
--
-- NOT-NULL backfill: docs.space_id is NOT NULL in the final schema, but `docs`
-- may already hold rows. We add it nullable, backfill every existing doc to the
-- single Phase-1 space (created lazily here from the first admin), then set NOT
-- NULL — the add-nullable → backfill → set-not-null dance. A fresh deploy has no
-- docs, so the backfill is a no-op and the bootstrap space row is harmless
-- (the import command creates the real space; this row only exists to satisfy
-- the FK for any pre-existing docs).
--> statement-breakpoint
CREATE TYPE "public"."space_visibility" AS ENUM('private', 'unlisted', 'public');--> statement-breakpoint
CREATE TYPE "public"."space_role" AS ENUM('owner', 'writer', 'reader');--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" integer NOT NULL,
	"visibility" "space_visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "spaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "space_members" (
	"space_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role" "space_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_members_space_id_user_id_pk" PRIMARY KEY("space_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "principal_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"token_hash" text NOT NULL,
	"label" text NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "principal_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_members" ADD CONSTRAINT "space_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "principal_tokens" ADD CONSTRAINT "principal_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_members_user_idx" ON "space_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "principal_tokens_user_idx" ON "principal_tokens" USING btree ("user_id");--> statement-breakpoint
-- ── docs projection columns ────────────────────────────────────────────────
-- Add space_id NULLABLE first (existing rows have none yet).
ALTER TABLE "docs" ADD COLUMN "space_id" integer;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "current_commit" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "rendered_cache" text;--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "parsed_frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill: if any docs exist, ensure a bootstrap space exists (owned by the
-- lowest-id active admin, else the lowest-id user) and assign every doc to it.
-- Idempotent and skipped entirely on a fresh (doc-less) deploy.
DO $$
DECLARE
  v_owner integer;
  v_space integer;
BEGIN
  IF EXISTS (SELECT 1 FROM "docs" WHERE "space_id" IS NULL) THEN
    SELECT id INTO v_owner FROM "users"
      WHERE active = 1 AND role = 'admin' ORDER BY id ASC LIMIT 1;
    IF v_owner IS NULL THEN
      SELECT id INTO v_owner FROM "users" ORDER BY id ASC LIMIT 1;
    END IF;
    -- A space needs an owner FK. If there is genuinely no user at all, we
    -- cannot create the space; leave space_id null and the NOT NULL below will
    -- fail loudly (a docs-without-users state should never reach production).
    IF v_owner IS NOT NULL THEN
      SELECT id INTO v_space FROM "spaces" WHERE "slug" = 'workspace' LIMIT 1;
      IF v_space IS NULL THEN
        INSERT INTO "spaces" ("slug", "owner_user_id", "visibility")
          VALUES ('workspace', v_owner, 'private') RETURNING id INTO v_space;
        INSERT INTO "space_members" ("space_id", "user_id", "role")
          VALUES (v_space, v_owner, 'owner')
          ON CONFLICT ("space_id", "user_id") DO NOTHING;
      END IF;
      UPDATE "docs" SET "space_id" = v_space WHERE "space_id" IS NULL;
    END IF;
  END IF;
END $$;--> statement-breakpoint
-- Now enforce NOT NULL + the FK + the lookup index.
ALTER TABLE "docs" ALTER COLUMN "space_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docs_space_idx" ON "docs" USING btree ("space_id");
