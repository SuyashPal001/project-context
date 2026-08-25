ALTER TABLE "document_chunks" ADD COLUMN IF NOT EXISTS "person_folder_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_chunks_person_folder_idx" ON "document_chunks" USING btree ("person_folder_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chunks_sensitivity" ON "document_chunks" USING btree ("tenant_id","sensitivity_level");