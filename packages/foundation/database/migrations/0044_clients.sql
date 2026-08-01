DO $$ BEGIN
 CREATE TYPE "public"."client_status" AS ENUM('active', 'archived');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"brand_name" text,
	"logo_url" text,
	"brand_color" text,
	"status" "client_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp,
	CONSTRAINT "clients_tenant_slug_unique" UNIQUE("tenant_id","slug")
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "clients" ADD CONSTRAINT "clients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "clients_tenant_status_idx" ON "clients" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "project_plans" ADD COLUMN IF NOT EXISTS "client_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "project_plans" ADD CONSTRAINT "project_plans_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_plans_client_idx" ON "project_plans" USING btree ("client_id");
