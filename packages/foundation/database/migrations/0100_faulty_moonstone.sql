ALTER TABLE "skills" DROP CONSTRAINT "skills_owner_tenant_id_slug_unique";--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "owner_tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "showcase" jsonb;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_tenant_id_slug_unique" UNIQUE NULLS NOT DISTINCT("owner_tenant_id","slug");