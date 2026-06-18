CREATE TABLE "catalog_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"item_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"status" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_hash" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_kind" text NOT NULL,
	"from_item_id" text NOT NULL,
	"to_kind" text NOT NULL,
	"to_item_id" text NOT NULL,
	"link_type" text DEFAULT 'references' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_schemas" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"id_pattern" text NOT NULL,
	"schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "catalog_schemas_kind_unique" UNIQUE("kind")
);
--> statement-breakpoint
ALTER TABLE "catalog_items" ADD CONSTRAINT "catalog_items_kind_catalog_schemas_kind_fk" FOREIGN KEY ("kind") REFERENCES "public"."catalog_schemas"("kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_items_kind_item_idx" ON "catalog_items" USING btree ("kind","item_id");--> statement-breakpoint
CREATE INDEX "catalog_items_kind_idx" ON "catalog_items" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_links_edge_idx" ON "catalog_links" USING btree ("from_kind","from_item_id","to_kind","to_item_id","link_type");--> statement-breakpoint
CREATE INDEX "catalog_links_from_idx" ON "catalog_links" USING btree ("from_kind","from_item_id");--> statement-breakpoint
CREATE INDEX "catalog_links_to_idx" ON "catalog_links" USING btree ("to_kind","to_item_id");