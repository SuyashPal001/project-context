ALTER TABLE "users" ADD COLUMN "personal_identifier" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_personal_identifier_unique" UNIQUE("personal_identifier");