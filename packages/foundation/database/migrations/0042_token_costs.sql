CREATE TABLE IF NOT EXISTS "token_costs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "agent_id" text,
  "workflow_id" text,
  "run_id" text,
  "model" text NOT NULL,
  "input_tokens" integer DEFAULT 0 NOT NULL,
  "output_tokens" integer DEFAULT 0 NOT NULL,
  "cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_tenant_time_idx" ON "token_costs" ("tenant_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_costs_workflow_idx" ON "token_costs" ("workflow_id");
