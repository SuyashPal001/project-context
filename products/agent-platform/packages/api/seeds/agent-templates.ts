/**
 * Seeds the published platform agent template.
 *
 * Both consumers of the platform prompt read this row:
 *   - apps/agent-orchestrator platformAgent.instructions, via fetchPlatformPrompt()
 *   - apps/api onboarding, when seeding a new tenant's Research Engineer
 *
 * Until this row existed the table was empty, so fetchPlatformPrompt() fell back
 * to the literal string "You are Disco, a helpful AI assistant." — every agent
 * without a per-agent override ran with no product knowledge whatsoever.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:templates
 */

import postgres from 'postgres';
import { buildPlatformPrompt } from '../lib/agentPrompts';

const TEMPLATE_NAME = 'platform-default';

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    const systemPrompt = buildPlatformPrompt();

    // createdBy is NOT NULL with an FK to users, and a template is a platform
    // artefact rather than a tenant one — attribute it to the oldest user.
    const [owner] = await sql<{ id: string }[]>`
      SELECT id FROM users ORDER BY created_at ASC LIMIT 1
    `;
    if (!owner) {
      console.warn('[seed:templates] no users exist yet — run this after the first signup');
      return;
    }

    const [existing] = await sql<{ id: string; version: number }[]>`
      SELECT id, version FROM agent_templates
      WHERE name = ${TEMPLATE_NAME}
      ORDER BY version DESC LIMIT 1
    `;

    if (existing) {
      await sql`
        UPDATE agent_templates
        SET system_prompt = ${systemPrompt},
            status = 'published',
            published_at = now(),
            updated_at = now()
        WHERE id = ${existing.id}
      `;
      console.log(`[seed:templates] updated ${TEMPLATE_NAME} v${existing.version}`);
      return;
    }

    await sql`
      INSERT INTO agent_templates (name, description, system_prompt, version, status, published_at, created_by)
      VALUES (
        ${TEMPLATE_NAME},
        'Default platform prompt, including file upload guidance.',
        ${systemPrompt},
        1,
        'published',
        now(),
        ${owner.id}
      )
    `;
    console.log(`[seed:templates] inserted ${TEMPLATE_NAME} v1`);
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:templates] failed', err);
  process.exit(1);
});
