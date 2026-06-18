CREATE TABLE "user_emails" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_emails_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "user_emails" ADD CONSTRAINT "user_emails_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_emails_user_idx" ON "user_emails" USING btree ("user_id");--> statement-breakpoint
-- Backfill: mirror every existing users.email (the primary) into user_emails so
-- the auth-resolution lookup is a single table. users.email is already
-- normalized (trim + lowercase) at write time and globally unique. We re-apply
-- lower(trim()) defensively so any pre-existing un-normalized row still mirrors
-- to the same value the lookup normalizes to; the user_emails unique(email)
-- constraint keeps it 1:1.
INSERT INTO "user_emails" ("user_id", "email")
SELECT "id", lower(trim("email")) FROM "users" WHERE "email" IS NOT NULL;