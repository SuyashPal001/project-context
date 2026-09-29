ALTER TABLE "creative_library_assets" ADD COLUMN "file_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_library_assets" ADD CONSTRAINT "creative_library_assets_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "creative_library_assets" ADD CONSTRAINT "creative_library_assets_file_id_unique" UNIQUE("file_id");