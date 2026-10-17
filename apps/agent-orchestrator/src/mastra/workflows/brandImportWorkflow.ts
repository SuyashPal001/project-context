import { createStep, createWorkflow } from '@mastra/core/workflows'
import { z } from 'zod'

import { brandFillAgent, brandFillOutputSchema, buildFillPrompt, clampFill } from '../agents/brandFillAgent.js'
import { fetchInstagramProfile } from '../brand/tikhub.js'
import { fetchInstagramImage } from '../brand/safeImage.js'
import { persistCost } from '../cost.js'
import type { InstagramFacts, WebsiteFacts } from '../brand/types.js'

const FILL_MODEL = process.env.MASTRA_LITE_MODEL ?? 'gemini-3.6-flash'

// The API's import-result route caps sourceText at 20,000 chars (z.string().max(20_000)) —
// an over-length body fails the whole report, not just that field. Caption-level capping
// keeps one runaway caption from eating the whole budget before the join+slice below.
const MAX_CAPTION_CHARS = 1_500
const MAX_SOURCE_TEXT_CHARS = 20_000

const capCaptions = (captions: string[]) => captions.map((c) => c.slice(0, MAX_CAPTION_CHARS))
const joinSourceText = (parts: string[]) => parts.filter(Boolean).join('\n').slice(0, MAX_SOURCE_TEXT_CHARS)

const inputSchema = z.object({
  tenantId: z.string().uuid(),
  source: z.enum(['website', 'instagram']),
  handle: z.string().optional(),
  facts: z.any().optional(), // WebsiteFacts, validated by the API that built it
})

const gatheredSchema = z.object({
  tenantId: z.string(),
  website: z.any().optional(),
  instagram: z.any().optional(),
  logoUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  sourceText: z.string(),
})

const filledSchema = gatheredSchema.extend({ fields: brandFillOutputSchema })

const gather = createStep({
  id: 'gather',
  inputSchema,
  outputSchema: gatheredSchema,
  execute: async ({ inputData }) => {
    if (inputData.source === 'instagram') {
      const ig: InstagramFacts | null = inputData.handle ? await fetchInstagramProfile(inputData.handle) : null
      if (!ig) throw new Error('instagram profile could not be read')
      return {
        tenantId: inputData.tenantId, instagram: ig, logoUrl: ig.profilePicUrl ?? undefined,
        sourceText: joinSourceText([ig.fullName ?? '', ig.bio ?? '', ...capCaptions(ig.captions)]),
      }
    }
    const w = inputData.facts as WebsiteFacts | undefined
    if (!w) throw new Error('website facts missing')
    // Prefer an explicit logo candidate; a .ico favicon isn't a usable logo image, so skip
    // past it. Reported to the API, which saves it; never downloaded here.
    const nonIcoIcon = w.iconUrls.find((u) => !u.toLowerCase().endsWith('.ico'))
    return {
      tenantId: inputData.tenantId, website: w,
      logoUrl: w.logoCandidates[0] ?? nonIcoIcon,
      faviconUrl: w.iconUrls[0],
      sourceText: joinSourceText([w.siteName ?? '', w.title ?? '', w.description ?? '', ...w.headings, ...w.ctas, w.bodyText]),
    }
  },
})

const fill = createStep({
  id: 'fill',
  inputSchema: gatheredSchema,
  outputSchema: filledSchema,
  execute: async ({ inputData }) => {
    const prompt = buildFillPrompt({ website: inputData.website, instagram: inputData.instagram })
    // Only the Instagram profile picture is ever downloaded here, through the guarded
    // helper. Website logo URLs come from the page itself and could point anywhere, so
    // the website fill runs text-only (its CSS colours are already in the facts); the
    // API saves the logo with its own SSRF-guarded fetch.
    const logo = inputData.instagram && inputData.logoUrl ? await fetchInstagramImage(inputData.logoUrl) : null
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }]
    if (logo) content.unshift({ type: 'image', image: logo.base64, mimeType: logo.mimeType })
    const result = await brandFillAgent.generate(
      [{ role: 'user', content }] as never,
      { structuredOutput: { schema: brandFillOutputSchema } },
    )
    const usage = (result as { usage?: { inputTokens?: number; outputTokens?: number } }).usage
    if (usage) {
      // Not charged to the tenant (spec) — logged so the cost stays visible.
      persistCost({ tenantId: inputData.tenantId, agentId: 'brand-fill', workflowId: 'creative-brand', model: FILL_MODEL, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 })
    }
    if (!result.object) throw new Error('fill returned no object')
    return { ...inputData, fields: clampFill(brandFillOutputSchema.parse(result.object)) }
  },
})

export async function reportImportResult(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${process.env.API_BASE_URL ?? ''}/api/v1/internal/brand/import-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`import-result HTTP ${res.status}`)
}

const report = createStep({
  id: 'report',
  inputSchema: filledSchema,
  outputSchema: z.object({ ok: z.boolean() }),
  execute: async ({ inputData }) => {
    await reportImportResult({
      tenantId: inputData.tenantId, ok: true, fields: inputData.fields, sourceText: inputData.sourceText,
      logoUrl: inputData.logoUrl, faviconUrl: inputData.faviconUrl,
    })
    return { ok: true }
  },
})

export const brandImportWorkflow = createWorkflow({
  id: 'brand-import-workflow',
  inputSchema,
  outputSchema: z.object({ ok: z.boolean() }),
})
  .then(gather)
  .then(fill)
  .then(report)
  .commit()
