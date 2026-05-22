CREATE TYPE "public"."fairness_status" AS ENUM('pass', 'warn', 'fail');

CREATE TABLE "agent_fairness_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "run_by" uuid NOT NULL REFERENCES "users"("id"),
  "run_at" timestamp DEFAULT now() NOT NULL,
  "overall_status" "fairness_status" NOT NULL,
  "check_results" jsonb NOT NULL,
  "notes" text
);

CREATE INDEX "fairness_reviews_agent_idx" ON "agent_fairness_reviews" ("agent_id");
CREATE INDEX "fairness_reviews_tenant_idx" ON "agent_fairness_reviews" ("tenant_id");
