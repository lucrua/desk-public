CREATE TABLE "audiences" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"member_visible" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "audiences_key_unique" UNIQUE("key")
);
--> statement-breakpoint
-- Seed the canonical audiences. `team` is the only member-visible one — it
-- preserves the previous hardcoded rule (members saw only team docs).
INSERT INTO "audiences" ("key", "label", "member_visible") VALUES
	('team', 'Team', 1),
	('pedro', 'Pedro', 0),
	('dani', 'Dani', 0)
ON CONFLICT ("key") DO NOTHING;
--> statement-breakpoint
-- Backfill any audience value already present on existing docs that the three
-- canonical rows don't cover (e.g. `external:PartnerCo`). Label = the raw value;
-- member_visible 0 so prod docs stay valid without exposing them to members.
INSERT INTO "audiences" ("key", "label", "member_visible")
SELECT DISTINCT d."audience", d."audience", 0
FROM "docs" d
WHERE d."audience" NOT IN (SELECT "key" FROM "audiences")
ON CONFLICT ("key") DO NOTHING;
