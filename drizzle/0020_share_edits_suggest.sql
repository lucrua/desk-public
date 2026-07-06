-- 0020_share_edits_suggest
-- Slice 3: Tier-1 anonymous "suggest an edit" on the share surface.
--
-- A share-link visitor (no account, capability-token-scoped) may propose a full
-- new doc body ON A SHARE WHOSE OWNER ENABLED EDITS. The suggestion queues as a
-- `revisions` row the owner reviews with the existing diff UI and accepts (→ a
-- git commit via the Slice-2 path) or rejects. This mirrors share-COMMENTS:
-- per-share toggle, forced identity, uniform-404 on every failure, rate-limited.
--
--   - shares.allow_edits  — the per-share toggle, FAIL-CLOSED default OFF (the
--     sibling of allow_comments). A visitor may suggest an edit iff this is true;
--     when false the suggest endpoints return a uniform 404 (indistinguishable
--     from a dead token — no "edits disabled" existence hint).
--   - revisions.share_id  — the originating share for a share-suggestion (NULL
--     for a staff-proposed revision). FK to shares(id).
--   - revisions.proposer_label — the FORCED display label for a share suggestion
--     ("link:<share label>", never client-supplied). NULL for staff proposals.
--
-- shares.id / revisions.id / docs.id are integer/serial — share_id is integer.
ALTER TABLE "shares" ADD COLUMN "allow_edits" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "share_id" integer;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "proposer_label" text;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE no action ON UPDATE no action;
