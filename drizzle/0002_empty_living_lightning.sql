CREATE TABLE "access_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"hits" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "access_requests_email_unique" UNIQUE("email")
);
