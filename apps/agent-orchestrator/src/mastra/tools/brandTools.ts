import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { API_BASE_URL } from '../../types.js'

const COLOR = z.string().regex(/^#[0-9A-Fa-f]{6}$/)

export const updateBrandTool = createTool({
  id: 'update_brand',
  description: "Save lasting facts about the workspace's brand that the user stated: its name, one-line description, audience, region, tone words, emoji policy, phrases it owns, phrases it never uses, calls to action, voice notes, colours, headline font or logo. Send only the fields that changed. Never use it for a choice that applies to one ad only.",
  inputSchema: z.object({
    name: z.string().max(80).optional(),
    oneLiner: z.string().max(200).optional(),
    audience: z.string().max(300).optional(),
    region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']).optional(),
    toneWords: z.array(z.string().max(30)).max(5).optional(),
    emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']).optional(),
    signaturePhrases: z.array(z.string().max(80)).max(10).optional(),
    bannedPhrases: z.array(z.string().max(80)).max(30).optional(),
    ctaExamples: z.array(z.string().max(80)).max(10).optional(),
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
    const fields = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined))
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
