-- Full-text search over docs (§7.5 platform-shortfalls batch).
--
-- `docs.search_tsv` is a weighted tsvector maintained ON PUBLISH inside the
-- publishDoc transaction (setweight title='A' || content='B'). A GIN index
-- backs websearch_to_tsquery lookups. This migration adds the column + index
-- and backfills it from every doc's CURRENT version content so existing docs
-- are searchable immediately (without waiting for a re-publish).
--
-- Title is weight A (a title match outranks a body match); current-version
-- content is weight B. Only the CURRENT version is indexed — historical
-- versions are not searchable (matches the "current content" spec).

ALTER TABLE "docs" ADD COLUMN "search_tsv" tsvector;--> statement-breakpoint

CREATE INDEX "docs_search_tsv_idx" ON "docs" USING gin ("search_tsv");--> statement-breakpoint

-- Backfill from each doc's current version. Docs with no current version
-- (never published / placeholder) get title-only weight, so they still match
-- on title. coalesce guards a null content join.
UPDATE "docs" AS d
SET "search_tsv" =
  setweight(to_tsvector('english', coalesce(d."title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce(v."content", '')), 'B')
FROM (SELECT "id", "content" FROM "doc_versions") AS v
WHERE d."current_version_id" = v."id";--> statement-breakpoint

-- Docs with no current version still get a title-only vector (so a title
-- search finds an unpublished-from-creation doc).
UPDATE "docs" AS d
SET "search_tsv" = setweight(to_tsvector('english', coalesce(d."title", '')), 'A')
WHERE d."current_version_id" IS NULL;
