-- Person folders: one folder per pension holder identified by free-text string
CREATE TYPE "folder_status" AS ENUM ('pending', 'verified', 'ingested');--> statement-breakpoint

CREATE TABLE "person_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "identifier" varchar(255) NOT NULL,
  "display_name" varchar(255),
  "status" "folder_status" NOT NULL DEFAULT 'pending',
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE UNIQUE INDEX "person_folders_tenant_identifier_idx" ON "person_folders" ("tenant_id", "identifier");--> statement-breakpoint
CREATE INDEX "person_folders_tenant_idx" ON "person_folders" ("tenant_id");--> statement-breakpoint

-- Link files to a person folder
ALTER TABLE "files" ADD COLUMN "person_folder_id" uuid REFERENCES "person_folders"("id");--> statement-breakpoint
CREATE INDEX "files_person_folder_idx" ON "files" ("person_folder_id");--> statement-breakpoint

-- Link knowledge chunks to a person folder for scoped RAG
ALTER TABLE "knowledge_chunks" ADD COLUMN "person_folder_id" uuid REFERENCES "person_folders"("id");--> statement-breakpoint
CREATE INDEX "knowledge_chunks_person_folder_idx" ON "knowledge_chunks" ("person_folder_id");
