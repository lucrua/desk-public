-- 0022_drop_audience_catalog_cruft
-- Slice 6: destructive cruft deletion (owner-authorized full excision of the
-- retired Gen-1 audience model + the dormant P3 "schema-as-data" catalog
-- registry). The code paths that touched these were removed in Slice 6a/6b;
-- this drops the now-unreferenced tables + column from the DB.
--
-- DROP ORDER: children before parents so FK references never block a drop.
--   audience_members → audiences         (audience_members.audience_id → audiences.id)
--   catalog_links → catalog_items → catalog_schemas
--                                        (catalog_items.kind → catalog_schemas.kind;
--                                         catalog_links has no DB FK but is the leaf edge)
-- IF EXISTS on every statement so a re-run (or a DB that never had them) is a
-- clean no-op. Read access has been space-scoped since the Gen-2 consolidation,
-- so docs.audience gated nothing — dropping it is safe.

DROP TABLE IF EXISTS "audience_members";--> statement-breakpoint
DROP TABLE IF EXISTS "audiences";--> statement-breakpoint
DROP TABLE IF EXISTS "catalog_links";--> statement-breakpoint
DROP TABLE IF EXISTS "catalog_items";--> statement-breakpoint
DROP TABLE IF EXISTS "catalog_schemas";--> statement-breakpoint
ALTER TABLE "docs" DROP COLUMN IF EXISTS "audience";
