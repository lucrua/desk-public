CREATE TYPE "public"."doc_format" AS ENUM('md', 'html');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp DEFAULT now() NOT NULL,
	"published_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"source_path" text NOT NULL,
	"audience" text NOT NULL,
	"format" "doc_format" DEFAULT 'md' NOT NULL,
	"current_version_id" integer,
	"unpublished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"share_id" integer NOT NULL,
	"doc_version_id" integer NOT NULL,
	"viewed_at" timestamp DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"doc_id" integer NOT NULL,
	"label" text NOT NULL,
	"created_by" text NOT NULL,
	"expires_at" timestamp,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text,
	"token_name" text,
	"display_name" text NOT NULL,
	"role" "role" DEFAULT 'member' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_token_name_unique" UNIQUE("token_name")
);
--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_views" ADD CONSTRAINT "share_views_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_views" ADD CONSTRAINT "share_views_doc_version_id_doc_versions_id_fk" FOREIGN KEY ("doc_version_id") REFERENCES "public"."doc_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docs_slug_idx" ON "docs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_token_idx" ON "shares" USING btree ("token_hash");