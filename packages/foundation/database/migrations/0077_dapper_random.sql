CREATE TYPE "public"."person_folder_status" AS ENUM('pending', 'verified');--> statement-breakpoint
ALTER TABLE "person_folders" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "person_folders" ADD COLUMN "status" "person_folder_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "person_folders" ADD COLUMN "created_by" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "person_folders" ADD CONSTRAINT "person_folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
