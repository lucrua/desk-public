-- 0021_source_modes_mirror
-- Slice 4b: per-space SOURCE MODE + one-way GitHub mirror-out (durability; kills
-- finding 5 — no backup story for canon). Decisions D-C3 / D-C4 / D-C5.
--
-- Every repo has exactly ONE push target; the other side is read-only:
--   - spaces.source_mode — 'hosted' (DEFAULT, Desk is canon) or 'mirrored'
--     (GitHub is canon; Desk refuses its own content writes and only accepts the
--     GitHub Action's git push). NOT NULL DEFAULT 'hosted' so every existing
--     space keeps today's behaviour.
--   - spaces.mirror_remote_url — the paired GitHub repo (https/ssh); NULL = none.
--     Lives in Postgres (data egress, owner/admin-set) — never in-repo (D-C4).
--   - spaces.mirror_state (jsonb) — {lastMirroredSha, lastAttemptAt, lastError}
--     for the settings UI + "Mirror now" button. NULL until the first attempt.
--   - spaces.mirror_deploy_key_enc — optional per-space SSH private key override,
--     AES-256-GCM-encrypted with DESK_TOKEN_KEY (D-C5). WRITE-ONLY (never revealed).
--   - instance_settings — a tiny key→encrypted-value store; v1 holds the instance
--     GitHub mirror PAT (fine-grained Contents:R/W), AES-256-GCM-encrypted with
--     DESK_TOKEN_KEY, write-only (no reveal endpoint).
--
-- spaces.id is integer/serial; the mirror columns are plain nullable columns.
CREATE TYPE "public"."space_source_mode" AS ENUM('hosted', 'mirrored');--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "source_mode" "space_source_mode" DEFAULT 'hosted' NOT NULL;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "mirror_remote_url" text;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "mirror_state" jsonb;--> statement-breakpoint
ALTER TABLE "spaces" ADD COLUMN "mirror_deploy_key_enc" text;--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value_enc" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
