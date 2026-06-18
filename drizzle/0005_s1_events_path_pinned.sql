CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"doc_id" integer,
	"payload" jsonb NOT NULL,
	"actor_name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "path" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "pinned_version_id" integer;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_pinned_version_id_doc_versions_id_fk" FOREIGN KEY ("pinned_version_id") REFERENCES "public"."doc_versions"("id") ON DELETE no action ON UPDATE no action;