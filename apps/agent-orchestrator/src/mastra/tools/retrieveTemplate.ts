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
      console.error('[retrieveTemplate] pool error:', err.message)
    })
  }
  return _pool
}

const technicalSchema = z.object({
  aspectRatio: z.string(),
  durationSeconds: z.number(),
  resolution: z.string(),
  fps: z.number(),
})

const sceneSchema = z.object({
  order: z.number(),
  shotType: z.string(),
  action: z.string(),
  onScreenText: z.string().optional(),
  audio: z.string().optional(),
})

export const retrieveTemplate = createTool({
  id: 'retrieve-template',
  description: 'Fetches a creative-library template\'s full recreation contract by slug — structure, scenes, technical constraints, and what to keep vs exclude. Call this before generating anything from a brief that references a template.',
  requestContextSchema: tenantContextSchema,
  inputSchema: z.object({
    slug: z.string().describe('The template slug from the creative brief, e.g. "product-demo"'),
  }),
  outputSchema: z.union([
    z.object({
      found: z.literal(true),
      slug: z.string(),
      title: z.string(),
      category: z.string(),
      clonePrompt: z.string(),
      negativePrompt: z.string(),
      cloneNotes: z.string(),
      excludeInClone: z.string(),
      technical: technicalSchema,
      scenes: z.array(sceneSchema),
      referenceFileId: z.string().nullable(),
    }),
    z.object({ found: z.literal(false) }),
  ]),
  execute: async (inputData, execContext) => {
    const slug = (inputData as { slug: string } | undefined)?.slug ?? ''
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    const client = await getPool().connect()
    try {
      const { rows } = await client.query<{
        slug: string
        title: string
        category: string
        clone_prompt: string
        negative_prompt: string
        clone_notes: string
        exclude_in_clone: string
        technical: unknown
        scenes: unknown
        reference_file_id: string | null
      }>(
        // [review] tenantContextSchema defaults tenantId to '' when the
        // context hasn't resolved a tenant yet. Casting '' against the
        // tenant_id uuid column would raise "invalid input syntax for type
        // uuid" — the same failure class docs/media-generation/README.md's
        // "Known issues" section documents for fileIngest.ts. Guarding with
        // $2 <> '' means an unresolved tenantId still finds the global row
        // instead of crashing, which is correct here (unlike fetchPRD.ts,
        // where a PRD genuinely requires a real tenant).
        //
        // ORDER BY tenant_id NULLS LAST: ASC puts non-NULL rows first, so a
        // future tenant-owned override (once tenant-authored templates
        // exist) wins over the global row for the same slug. Do not "fix"
        // this to NULLS FIRST — that would invert the override, not just
        // the null placement.
        `SELECT slug, title, category, clone_prompt, negative_prompt, clone_notes,
                exclude_in_clone, technical, scenes, reference_file_id
         FROM creative_templates
         WHERE slug = $1 AND (tenant_id IS NULL OR ($2 <> '' AND tenant_id = $2::uuid)) AND status = 'active'
         ORDER BY tenant_id NULLS LAST
         LIMIT 1`,
        [slug, tenantId],
      )

      if (rows.length === 0) {
        return { found: false as const }
      }

      const row = rows[0]
      return {
        found: true,
        slug: row.slug,
        title: row.title,
        category: row.category,
        clonePrompt: row.clone_prompt,
        negativePrompt: row.negative_prompt,
        cloneNotes: row.clone_notes,
        excludeInClone: row.exclude_in_clone,
        technical: row.technical as z.infer<typeof technicalSchema>,
        scenes: row.scenes as z.infer<typeof sceneSchema>[],
        referenceFileId: row.reference_file_id,
      }
    } finally {
      client.release()
    }
  },
})
