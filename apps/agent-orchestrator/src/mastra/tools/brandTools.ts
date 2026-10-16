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

export const importBrandTool = createTool({
  id: 'import_brand',
  description: "Fill the workspace's brand from its website or Instagram handle. Use when the user shares their own site or handle to set up or refresh the brand. Fields the user already edited are kept.",
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
      const status = body.data?.importStatus ?? 'importing'
      return status === 'failed'
        ? { success: false, error: "Couldn't read that. Ask the user about their brand instead." }
        : { success: true, status, note: 'The brand will appear on the Brand page in about a minute.' }
    } catch (err) {
      console.error('[import_brand] failed', (err as Error).message)
      return { success: false, error: "Couldn't start reading that. Ask the user about their brand instead." }
    }
  },
})
