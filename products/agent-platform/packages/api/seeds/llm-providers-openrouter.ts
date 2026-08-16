/**
 * Seeds 3 curated OpenRouter-backed model rows for the chat model picker.
 *
 * Shipped as status: 'coming_soon' — there is no real OPENROUTER_API_KEY configured
 * yet (see apps/inference-gateway/.env.example). Flipping a row to 'live' once a key
 * is added is a one-row UPDATE, not a re-seed:
 *   UPDATE llm_providers SET status = 'live' WHERE provider = 'openrouter' AND model = '<model>';
 *
 * Model slugs are best-effort based on OpenRouter's vendor/model naming convention and
 * should be verified against OpenRouter's live catalog before flipping to 'live'.
 *
 * Run with: pnpm --filter @serverless-saas/agent-api db:seed:llm-providers-openrouter
 */

import postgres from 'postgres';

interface SeedRow {
  provider: 'openrouter';
  model: string;
  displayName: string;
  costPerToken: string; // relative ordering matters more than the exact value — see design doc
}

const ROWS: SeedRow[] = [
  { provider: 'openrouter', model: 'anthropic/claude-opus-5', displayName: 'Claude Opus 5', costPerToken: '0.00007500' },
  { provider: 'openrouter', model: 'openai/gpt-5.1', displayName: 'GPT-5.1', costPerToken: '0.00003000' },
  { provider: 'openrouter', model: 'google/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash (OpenRouter)', costPerToken: '0.00000500' },
];

async function run() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    for (const row of ROWS) {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM llm_providers
        WHERE provider = ${row.provider} AND model = ${row.model} AND is_platform = true
        LIMIT 1
      `;

      if (existing) {
        await sql`
          UPDATE llm_providers
          SET display_name = ${row.displayName}, cost_per_token = ${row.costPerToken}
          WHERE id = ${existing.id}
        `;
        console.log(`[seed:llm-providers-openrouter] updated ${row.displayName}`);
        continue;
      }

      await sql`
        INSERT INTO llm_providers (tenant_id, provider, model, api_key_encrypted, is_default, cost_per_token, display_name, is_platform, status)
        VALUES (
          NULL,
          ${row.provider},
          ${row.model},
          '',
          false,
          ${row.costPerToken},
          ${row.displayName},
          true,
          'coming_soon'
        )
      `;
      console.log(`[seed:llm-providers-openrouter] inserted ${row.displayName}`);
    }
  } finally {
    await sql.end();
  }
}

run().catch((err) => {
  console.error('[seed:llm-providers-openrouter] failed', err);
  process.exit(1);
});
