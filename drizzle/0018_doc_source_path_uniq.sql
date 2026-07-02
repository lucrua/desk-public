-- 0018_doc_source_path_uniq
-- Doc identity = stable opaque id (see docs/specs/doc-identity-opaque-id.md).
--   docs.slug becomes a PERMANENT random id, never derived from the repo path.
--   The projection resolves a repo file → its doc row by (space_id, source_path).
-- This is a NON-unique LOOKUP index for that pair (used by the indexer, tombstone,
-- rename, space file-view, and the web create-guard). It is deliberately NOT
-- unique: `source_path` is a provenance stamp and the legacy publish path may
-- reuse a path across docs; the collision fix lives in the indexer's keying +
-- opaque slugs, not a DB constraint.
CREATE INDEX "docs_space_source_path_idx" ON "docs" ("space_id","source_path");
