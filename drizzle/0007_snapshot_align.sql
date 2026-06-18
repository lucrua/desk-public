-- Snapshot alignment only: 0006 was hand-written (search_tsv column + GIN index)
-- without a generated snapshot, so drizzle-kit re-detected its DDL here.
-- The changes are already applied by 0006 — this migration is a deliberate no-op.
SELECT 1;
