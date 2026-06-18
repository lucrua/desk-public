CREATE TABLE "buckets" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "buckets_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"bucket_id" integer NOT NULL,
	"position" double precision NOT NULL,
	"owner_user_id" integer,
	"doc_slug" text,
	"checklist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"archived_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_bucket_id_buckets_id_fk" FOREIGN KEY ("bucket_id") REFERENCES "public"."buckets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cards_bucket_idx" ON "cards" USING btree ("bucket_id");--> statement-breakpoint
-- Seed the four generic buckets. Org-agnostic defaults; admins rename/reorder/
-- add/delete from the board. Positions are sparse so reorders have room.
INSERT INTO "buckets" ("key", "label", "position") VALUES
  ('backlog', 'Backlog', 1),
  ('in-progress', 'In Progress', 2),
  ('review', 'Review', 3),
  ('done', 'Done', 4)
ON CONFLICT ("key") DO NOTHING;