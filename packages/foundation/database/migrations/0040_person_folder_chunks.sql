-- Add person_folder_id to document_chunks for scoped RAG retrieval
ALTER TABLE "document_chunks" ADD COLUMN "person_folder_id" uuid REFERENCES "person_folders"("id");--> statement-breakpoint
CREATE INDEX "document_chunks_person_folder_idx" ON "document_chunks" ("person_folder_id");
