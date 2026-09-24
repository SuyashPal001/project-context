import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import pg from 'pg'
import { makeAppPool } from '../../db.js'
import { tenantContextSchema } from '../context.js'

let _pool: pg.Pool | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = makeAppPool(5)
    _pool.on('error', (err) => {
      console.error('[listCastingAssets] pool error:', err.message)
    })
  }
  return _pool
}

// Returns the raw catalogue, not a ranking — Olmo is itself the LLM that
// reasons over a free-text casting/voice brief against these 6-8 items and
// presents the best fits via ask_clarifying_questions (options + rationale
// already supports "ranked best-fit-first with a reason"). A separate
// scoring call would just be a second, worse LLM doing what the caller
// already can.
export const listCastingAssets = createTool({
  id: 'list-casting-assets',
  description: 'Fetches the platform casting library — either the avatar presets or the voice catalogue — so you can match a free-text brief (e.g. "energetic fitness guy", "something warm and friendly") against real options. Call this before presenting casting or voice choices whenever the user described a vibe rather than naming a specific preset.',
  requestContextSchema: tenantContextSchema,
  inputSchema: z.object({
    kind: z.enum(['avatar', 'voice']).describe('Which catalogue to fetch'),
  }),
  outputSchema: z.object({
    items: z.array(z.object({
      id: z.string().describe('Avatar asset id or voice providerId — pass this straight through as the pick'),
      name: z.string(),
      description: z.string(),
    })),
    error: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const kind = (inputData as { kind: 'avatar' | 'voice' } | undefined)?.kind
    if (kind !== 'avatar' && kind !== 'voice') {
      return { items: [], error: `invalid kind: expected "avatar" or "voice", got ${JSON.stringify(kind)}` }
    }
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      if (kind === 'voice') {
        const { rows } = await client.query<{ provider_id: string; name: string; tagline: string; description: string | null }>(
          `SELECT provider_id, name, tagline, description FROM voice_catalogue ORDER BY name`,
        )
        return {
          items: rows.map((row) => ({
            id: row.provider_id,
            name: row.name,
            description: row.description ? `${row.tagline} — ${row.description}` : row.tagline,
          })),
        }
      }

      // Same global-or-tenant scoping as retrieveTemplate.ts: $2 <> '' guards
      // an unresolved tenantId from being cast against the uuid column, and
      // every seeded row today is platform-owned (tenant_id IS NULL) —
      // tenant-authored assets are future scope, not built yet.
      const { rows } = await client.query<{ id: string; name: string; attributes: { role?: string; tone?: string } }>(
        `SELECT id, name, attributes
         FROM creative_library_assets
         WHERE kind = 'avatar' AND status = 'active' AND (tenant_id IS NULL OR ($1 <> '' AND tenant_id = $1::uuid))
         ORDER BY name`,
        [tenantId],
      )
      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: [row.attributes?.role, row.attributes?.tone].filter(Boolean).join(' · '),
        })),
      }
    } finally {
      client.release()
    }
  },
})
