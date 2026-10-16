import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { API_BASE_URL } from '../../types.js'
import type { TenantBrand } from '../brand/types.js'

const COLOR = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

// Saved lists are edited, never replaced: the model sends what to add and what
// to remove, and the tool builds the full list from the brand loaded this turn.
const LISTS = {
  toneWords: { add: 'addToneWords', remove: 'removeToneWords', max: 5 },
  signaturePhrases: { add: 'addSignaturePhrases', remove: 'removeSignaturePhrases', max: 10 },
  bannedPhrases: { add: 'addBannedPhrases', remove: 'removeBannedPhrases', max: 30 },
  ctaExamples: { add: 'addCtaExamples', remove: 'removeCtaExamples', max: 10 },
} as const
type ListKey = keyof typeof LISTS

/** Removes (case-insensitive), then adds new items not already present, capped at `max`. */
function editList(saved: string[], add: string[] = [], remove: string[] = [], max: number): string[] {
  const drop = new Set(remove.map((r) => r.trim().toLowerCase()))
  const out = saved.filter((s) => !drop.has(s.trim().toLowerCase()))
  for (const item of add) {
    const key = item.trim().toLowerCase()
    if (key && !out.some((s) => s.trim().toLowerCase() === key)) out.push(item.trim())
  }
  return out.slice(0, max)
}

const NO_BRAND: TenantBrand = {
  name: null, oneLiner: null, audience: null, region: 'IN', toneWords: [], emojiPolicy: 'minimal',
  signaturePhrases: [], bannedPhrases: [], ctaExamples: [], voiceNotes: null, colors: {}, headlineFont: null, logoFileId: null,
}

const words = (max: number, items: number) => z.array(z.string().max(max)).max(items).optional()

export const updateBrandTool = createTool({
  id: 'update_brand',
  description: "Save lasting facts about the workspace's brand that the user stated: its name, one-line description, audience, region, tone words, emoji policy, phrases it owns, phrases it never uses, calls to action, voice notes, colours, headline font or logo. Send only the fields that changed. Tone words, phrases and calls to action are added to or removed from the saved lists, never replaced: use the add/remove fields. Colours: send only the roles that changed; the others stay as saved. Never use it for a choice that applies to one ad only.",
  inputSchema: z.object({
    name: z.string().max(80).optional(),
    oneLiner: z.string().max(200).optional(),
    audience: z.string().max(300).optional(),
    region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']).optional(),
    addToneWords: words(30, 5), removeToneWords: words(30, 5),
    emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']).optional(),
    addSignaturePhrases: words(80, 10), removeSignaturePhrases: words(80, 10),
    addBannedPhrases: words(80, 30), removeBannedPhrases: words(80, 30),
    addCtaExamples: words(80, 10), removeCtaExamples: words(80, 10),
    voiceNotes: z.string().max(3000).optional(),
    colors: z.object({
      primary: COLOR.optional(), secondary: COLOR.optional(), accent: COLOR.optional(),
      text: COLOR.optional(), background: COLOR.optional(), muted: COLOR.optional(),
    }).optional(),
    headlineFont: z.string().max(60).optional(),
    logoFileId: z.string().uuid().optional().describe('fileId of a logo image the user sent in this chat'),
  }),
  execute: async (input, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!idToken) return { success: false, error: 'The brand can only be changed from a live chat.' }
    const listInputKeys = new Set<string>(Object.values(LISTS).flatMap((l) => [l.add, l.remove]))
    const fields: Record<string, unknown> = Object.fromEntries(
      Object.entries(input).filter(([k, v]) => v !== undefined && !listInputKeys.has(k)),
    )
    const brand = execContext?.requestContext?.get('brand') as TenantBrand | null | undefined
    const given = input as Record<string, string[] | undefined>
    for (const [key, l] of Object.entries(LISTS) as [ListKey, typeof LISTS[ListKey]][]) {
      if (!given[l.add] && !given[l.remove]) continue
      fields[key] = editList(brand?.[key] ?? [], given[l.add], given[l.remove], l.max)
    }
    if (Object.keys(fields).length === 0) return { success: false, error: 'Nothing to save.' }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/brand`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
      if (!res.ok) {
        console.error('[update_brand] API', res.status, await res.text().catch(() => ''))
        return { success: false, error: "The brand couldn't be saved. Try again." }
      }
      // The brand is loaded once per turn; keep this turn's copy current so a second
      // update_brand in the same turn edits the lists as just saved, not as loaded.
      const base = brand ?? NO_BRAND
      execContext?.requestContext?.set('brand', {
        ...base, ...fields, colors: { ...base.colors, ...(fields.colors as Record<string, string> | undefined) },
      } as TenantBrand)
      return { success: true, saved: Object.keys(fields) }
    } catch (err) {
      console.error('[update_brand] failed', (err as Error).message)
      return { success: false, error: "The brand couldn't be saved. Try again." }
    }
  },
})

/** The API's GET /brand record — only the fields Olmo needs. */
interface BrandRecordLite {
  name: string | null; oneLiner: string | null; audience: string | null; region: string
  toneWords: string[]; emojiPolicy: string; signaturePhrases: string[]; bannedPhrases: string[]
  ctaExamples: string[]; voiceNotes: string | null; colors: Record<string, string>
  headlineFont: string | null; logo: { fileId: string } | null; importStatus: string
}

/** How long import_brand waits for the fill. Mutable so tests can shorten it. */
export const IMPORT_WAIT = { intervalMs: 3000, timeoutMs: 60_000 }

/** Polls GET /brand until the import leaves 'importing'. Null when it is still running at the timeout. */
async function waitForImport(idToken: string): Promise<BrandRecordLite | null> {
  const deadline = Date.now() + IMPORT_WAIT.timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, IMPORT_WAIT.intervalMs))
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/brand`, { headers: { Authorization: `Bearer ${idToken}` } })
      if (!res.ok) continue
      const { data } = await res.json() as { data: BrandRecordLite | null }
      if (data && data.importStatus !== 'importing') return data
    } catch (err) {
      console.warn('[import_brand] status check failed', (err as Error).message)
    }
  }
  return null
}

function toTenantBrand(r: BrandRecordLite): TenantBrand {
  return {
    name: r.name, oneLiner: r.oneLiner, audience: r.audience, region: r.region, toneWords: r.toneWords,
    emojiPolicy: r.emojiPolicy, signaturePhrases: r.signaturePhrases, bannedPhrases: r.bannedPhrases,
    ctaExamples: r.ctaExamples, voiceNotes: r.voiceNotes, colors: r.colors ?? {}, headlineFont: r.headlineFont,
    logoFileId: r.logo?.fileId ?? null,
  }
}

/** What the import found, and what Olmo should ask about. */
export function summarizeBrand(r: BrandRecordLite): { found: Record<string, unknown>; missing: string[] } {
  const found: Record<string, unknown> = {}
  const missing: string[] = []
  const check = (label: string, value: unknown, present: boolean) => { if (present) found[label] = value; else missing.push(label) }
  check('name', r.name, Boolean(r.name?.trim()))
  check('what it makes', r.oneLiner, Boolean(r.oneLiner?.trim()))
  check('who it is for', r.audience, Boolean(r.audience?.trim()))
  check('how it sounds', r.toneWords, r.toneWords.length > 0)
  check('colours', r.colors, Object.keys(r.colors ?? {}).length > 0)
  check('logo', r.logo ? 'saved' : null, Boolean(r.logo))
  if (r.ctaExamples.length > 0) found['calls to action'] = r.ctaExamples
  return { found, missing }
}

export const importBrandTool = createTool({
  id: 'import_brand',
  description: "Fill the workspace's brand from its website or Instagram handle. Use when the user shares their own site or handle to set up or refresh the brand. Fields the user already edited are kept. Waits up to a minute for the result: status 'done' returns what was found and what is still missing; status 'importing' means it is still reading.",
  inputSchema: z.object({ value: z.string().min(1).max(500).describe('The website link or Instagram handle exactly as the user gave it') }),
  execute: async ({ value }, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    if (!idToken) return { success: false, error: 'The brand can only be set up from a live chat.' }
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/brand/import`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      })
      const body = await res.json().catch(() => ({})) as { message?: string; data?: { importStatus?: string } }
      if (res.status === 400) return { success: false, error: body.message ?? 'Paste a website link or an Instagram handle' }
      if (!res.ok) {
        console.error('[import_brand] API', res.status)
        return { success: false, error: "Couldn't start reading that. Ask the user about their brand instead." }
      }
      if ((body.data?.importStatus ?? 'importing') === 'failed') {
        return { success: false, error: "Couldn't read that. Ask the user about their brand instead." }
      }
      // Wait for the result so Olmo can say it's done and ask only about what's missing.
      const record = await waitForImport(idToken)
      if (!record) {
        return { success: true, status: 'importing', note: 'Still reading. Tell the user it will appear on the Brand page shortly, and offer to check again.' }
      }
      if (record.importStatus === 'failed') {
        return { success: false, error: "Couldn't read that. Ask the user about their brand instead." }
      }
      execContext?.requestContext?.set('brand' as never, toTenantBrand(record) as never)
      return { success: true, status: 'done', ...summarizeBrand(record) }
    } catch (err) {
      console.error('[import_brand] failed', (err as Error).message)
      return { success: false, error: "Couldn't start reading that. Ask the user about their brand instead." }
    }
  },
})
