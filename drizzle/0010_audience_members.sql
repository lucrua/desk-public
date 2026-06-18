CREATE TABLE "audience_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"audience_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_audience_id_audiences_id_fk" FOREIGN KEY ("audience_id") REFERENCES "public"."audiences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audience_members" ADD CONSTRAINT "audience_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audience_members_uniq" ON "audience_members" USING btree ("audience_id","user_id");--> statement-breakpoint
CREATE INDEX "audience_members_user_idx" ON "audience_members" USING btree ("user_id");--> statement-breakpoint
-- Seed the `private` audience — the new default for uploads/publishes that don't
-- name an audience. member_visible 0 (only the author/admins + explicitly-added
-- members see private docs). Idempotent: skip if a `private` key already exists.
INSERT INTO "audiences" ("key", "label", "member_visible") VALUES
  ('private', 'Private', 0)
ON CONFLICT ("key") DO NOTHING;
