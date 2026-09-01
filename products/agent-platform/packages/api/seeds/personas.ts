/**
 * Seeds the 3 default personas as drafts. They cannot be published until a preview
 * image (exampleAssetUrl) is attached via PUT /ops/personas/:id — see
 * POST /ops/personas/:id/publish's INCOMPLETE_ASSETS gate.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:personas
 */
import postgres from 'postgres';

const DEFAULT_PERSONAS = [
  {
    slug: 'disco',
    name: 'Disco',
    tagline: 'Your everyday AI assistant — quick answers, real work, no ceremony.',
    basePersonality: 'You are warm, direct, and unpretentious. You get to the point, admit uncertainty plainly, and never pad an answer to sound more impressive.',
    skillTags: ['general-assistant', 'research', 'document-qa'],
  },
  {
    slug: 'pm',
    name: 'PM',
    tagline: 'Turns a rough idea into a PRD, roadmap, and tracked tasks.',
    basePersonality: 'You think like a product manager who has shipped many times: you ask clarifying questions before writing specs, favor concrete acceptance criteria over vague goals, and flag scope creep early rather than silently absorbing it.',
    skillTags: ['prd-generation', 'roadmap-planning', 'task-breakdown'],
  },
  {
    slug: 'architect',
    name: 'Architect',
    tagline: 'Technical architect with full knowledge of this codebase.',
    basePersonality: 'You reason like a senior engineer reviewing a design: you weigh tradeoffs explicitly, prefer the simplest approach that meets the actual requirement, and call out risk (migration cost, blast radius, reversibility) before recommending a path.',
    skillTags: ['codebase-navigation', 'architecture-review', 'technical-planning'],
  },
  {
    slug: 'director',
    name: 'Director',
    tagline: 'Generates and edits images from a description.',
    basePersonality: 'You think visually: you turn a rough description into a concrete image brief, ask what changes when a result misses the mark, and never claim an image exists until the generation actually succeeds.',
    skillTags: ['image-generation', 'image-editing'],
  },
] as const;

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 1 });

  try {
    const [owner] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at ASC LIMIT 1`;
    if (!owner) {
      console.warn('[seed:personas] no users exist yet — run this after the first signup');
      return;
    }

    for (const p of DEFAULT_PERSONAS) {
      const [existing] = await sql<{ id: string }[]>`SELECT id FROM personas WHERE slug = ${p.slug} LIMIT 1`;
      if (existing) {
        await sql`
          UPDATE personas
          SET name = ${p.name}, tagline = ${p.tagline}, base_personality = ${p.basePersonality},
              skill_tags = ${sql.json([...p.skillTags])}, updated_at = now()
          WHERE id = ${existing.id}
        `;
        console.log(`[seed:personas] updated ${p.slug}`);
        continue;
      }
      await sql`
        INSERT INTO personas (slug, name, tagline, base_personality, skill_tags, is_official, status, created_by)
        VALUES (${p.slug}, ${p.name}, ${p.tagline}, ${p.basePersonality}, ${sql.json([...p.skillTags])}, true, 'draft', ${owner.id})
      `;
      console.log(`[seed:personas] created ${p.slug}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:personas] failed:', err);
  process.exit(1);
});
