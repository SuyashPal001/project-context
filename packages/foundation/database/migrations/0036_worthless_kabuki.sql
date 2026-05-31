ALTER TABLE "audit_log" ADD COLUMN "previous_state" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "new_state" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "prev_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "entry_hash" varchar(64);