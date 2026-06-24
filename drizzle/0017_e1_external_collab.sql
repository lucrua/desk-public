-- 0017_e1_external_collab
-- External Collaboration, Slice E1 (specs/desk/external-collaboration-spec.md §E1).
--
-- Adds:
--   1. spaces.push_policy — the git-push branch-protection mode. NOT NULL with a
--      DEFAULT of 'direct', so every existing space keeps today's behaviour (a
--      writer may push `main`). The 'proposal' mode is ENFORCED in Slice E2; E1
--      only stores it + reflects it in the setup-prompt template and the UI.
--   2. space_invites — a capability link that lets an external partner self-serve
--      into a space at a writer|reader role. sha256-at-rest token (raw shown once,
--      mirrors `shares` / `principal_tokens`); resolution by tokenHash; uniform
--      404 on every failure (unknown / expired / over-maxUses / revoked). Account
--      creation is GATED by a valid invite.
--> statement-breakpoint
CREATE TYPE "public"."space_push_policy" AS ENUM('direct', 'proposal');--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "push_policy" "space_push_policy" DEFAULT 'direct' NOT NULL;--> statement-breakpoint
CREATE TABLE "space_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"space_id" integer NOT NULL,
	"role" "space_role" NOT NULL,
	"token_hash" text NOT NULL,
	"email" text,
	"created_by_user_id" integer NOT NULL,
	"expires_at" timestamp,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "space_invites_token_hash_unique" UNIQUE("token_hash")
);--> statement-breakpoint
ALTER TABLE "space_invites" ADD CONSTRAINT "space_invites_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "space_invites" ADD CONSTRAINT "space_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "space_invites_space_idx" ON "space_invites" USING btree ("space_id");
