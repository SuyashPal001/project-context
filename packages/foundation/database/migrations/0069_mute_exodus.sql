CREATE TABLE IF NOT EXISTS "credit_accounts" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"balance_micro" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_type" "actor_type",
	"grant_type" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"spent_micro" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_type" "actor_type",
	"grant_id" uuid,
	"kind" text NOT NULL,
	"amount_micro" bigint NOT NULL,
	"balance_after_micro" bigint NOT NULL,
	"job_id" uuid,
	"job_type" text,
	"rate_id" uuid,
	"rate_version" integer,
	"idempotency_key" text NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_type" text NOT NULL,
	"subject" text DEFAULT '*' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pricing_schema" jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_tenant_id_credit_accounts_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."credit_accounts"("tenant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_tenant_id_credit_accounts_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."credit_accounts"("tenant_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_grant_id_credit_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."credit_grants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_rate_id_credit_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."credit_rates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_grants_fifo_idx" ON "credit_grants" USING btree ("tenant_id","expires_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_key_seq_uq" ON "credit_ledger" USING btree ("idempotency_key","seq");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_tenant_time_idx" ON "credit_ledger" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_rates_subject_version_uq" ON "credit_rates" USING btree ("resource_type","subject","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_rates_active_idx" ON "credit_rates" USING btree ("resource_type","subject") WHERE is_active;