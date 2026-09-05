-- Postgres requires ADD VALUE to run outside a transaction block in older
-- versions; IF NOT EXISTS makes the statement safe to re-apply.
ALTER TYPE "public"."skill_source_type" ADD VALUE IF NOT EXISTS 'authored';
