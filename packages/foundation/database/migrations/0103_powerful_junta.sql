ALTER TABLE "creative_brand" ADD COLUMN "font_file_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "creative_brand" ADD CONSTRAINT "creative_brand_font_file_id_files_id_fk" FOREIGN KEY ("font_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
