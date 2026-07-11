CREATE TABLE "person_folders" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "identifier" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX "person_folders_tenant_identifier_uniq" ON "person_folders" ("tenant_id", "identifier");--> statement-breakpoint
CREATE INDEX "person_folders_tenant_idx" ON "person_folders" ("tenant_id");--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "person_folder_id" uuid REFERENCES "person_folders"("id");
