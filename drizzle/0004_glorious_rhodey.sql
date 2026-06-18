CREATE TABLE "revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"base_version_id" integer NOT NULL,
	"content" text NOT NULL,
	"author_name" text NOT NULL,
	"author_kind" text NOT NULL,
	"note" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"decided_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_base_version_id_doc_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."doc_versions"("id") ON DELETE no action ON UPDATE no action;