-- Media generation rates (image_generation, music_generation, video_generation) were seeded
-- as placeholders below real Vertex AI provider cost — every image/music/video generation was
-- billing under cost. Deactivates the v1 placeholder rows and inserts v2 rows at cost + margin.
-- resolveRate() only reads isActive = true rows, exact subject over wildcard, so deactivating
-- v1 and activating v2 for the same (resource_type, subject) is enough to cut over — no code
-- change needed on the read side.
update credit_rates
   set is_active = false
 where resource_type in ('image_generation', 'music_generation', 'video_generation')
   and version = 1
   and is_active = true;
--> statement-breakpoint

insert into credit_rates (resource_type, subject, version, is_active, pricing_schema)
select 'image_generation', 'gemini-3-pro-image-preview', 2, true, '{"per_call_micro": 170000}'::jsonb
where not exists (
  select 1 from credit_rates where resource_type = 'image_generation' and subject = 'gemini-3-pro-image-preview' and version = 2
);
--> statement-breakpoint

insert into credit_rates (resource_type, subject, version, is_active, pricing_schema)
select 'music_generation', 'lyria-002', 2, true, '{"per_call_micro": 60000}'::jsonb
where not exists (
  select 1 from credit_rates where resource_type = 'music_generation' and subject = 'lyria-002' and version = 2
);
--> statement-breakpoint

insert into credit_rates (resource_type, subject, version, is_active, pricing_schema)
select 'video_generation', 'gemini-omni-1.1-flash', 2, true, '{"per_call_micro": 400000}'::jsonb
where not exists (
  select 1 from credit_rates where resource_type = 'video_generation' and subject = 'gemini-omni-1.1-flash' and version = 2
);
