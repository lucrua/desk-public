-- 0014_doc_owner
-- Adds docs.owner_user_id: the user who created this doc (admin-reassignable).
-- The owner may publish new versions directly (no approval queue). Nullable:
-- existing docs stay NULL (admin-only publish, unchanged). Set on CREATE only
-- (publishDoc never changes the owner on update). Admins may reassign via
-- setDocOwner.
--> statement-breakpoint
ALTER TABLE "docs" ADD COLUMN "owner_user_id" integer REFERENCES "users"("id");
