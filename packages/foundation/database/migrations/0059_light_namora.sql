CREATE TYPE "public"."skill_install_status" AS ENUM('active', 'uninstalled');--> statement-breakpoint
CREATE TYPE "public"."skill_source_type" AS ENUM('zip', 'github', 'url');--> statement-breakpoint
CREATE TYPE "public"."skill_version_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."skill_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_installs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"installed_version" integer NOT NULL,
	"auto_update" boolean DEFAULT false NOT NULL,
	"status" "skill_install_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_installs_tenant_id_skill_id_unique" UNIQUE("tenant_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skill_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb,
	"s3_prefix" text NOT NULL,
	"source_type" "skill_source_type" NOT NULL,
	"source_ref" text,
	"status" "skill_version_status" DEFAULT 'pending' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skill_versions_skill_id_version_unique" UNIQUE("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"visibility" "skill_visibility" DEFAULT 'private' NOT NULL,
	"is_official" boolean DEFAULT false NOT NULL,
	"latest_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "skills_owner_tenant_id_slug_unique" UNIQUE("owner_tenant_id","slug")
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "install_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_installs" ADD CONSTRAINT "skill_installs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_tenant_id_tenants_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_installs_tenant_status_idx" ON "skill_installs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skill_versions_skill_idx" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_visibility_idx" ON "skills" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_official_idx" ON "skills" USING btree ("is_official");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_install_id_skill_installs_id_fk" FOREIGN KEY ("install_id") REFERENCES "public"."skill_installs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
