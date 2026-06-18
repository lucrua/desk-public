ALTER TABLE "shares" ALTER COLUMN "doc_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "path_prefix" text;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_doc_xor_prefix" CHECK (("shares"."doc_id" is not null and "shares"."path_prefix" is null) or ("shares"."doc_id" is null and "shares"."path_prefix" is not null));