CREATE TABLE IF NOT EXISTS "voice_catalogue" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"tagline" text NOT NULL,
	"language" text,
	"gender" text,
	"country" text,
	"description" text,
	"accents" jsonb,
	"preview_file_url" text,
	"local_preview_asset" text,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL
);
