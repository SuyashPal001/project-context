ALTER TABLE "agent_templates" ADD COLUMN "tenant_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_templates" ADD CONSTRAINT "agent_templates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
