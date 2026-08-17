CREATE TABLE IF NOT EXISTS "agent_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_memories_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "credentials_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "integrations" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "identity_file" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "soul_file" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "agents_file" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "bootstrap_file" text;--> statement-breakpoint
ALTER TABLE "personas" ADD COLUMN "user_file" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
