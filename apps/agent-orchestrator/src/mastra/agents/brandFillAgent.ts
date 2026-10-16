import { Agent } from '@mastra/core/agent'
import { z } from 'zod'

import { liteModel } from '../model.js'
import type { InstagramFacts, WebsiteFacts } from '../brand/types.js'

// No-tools utility agent for brandImportWorkflow — same pattern as
// skillDraftAgent/formatterAgent: one focused structured call, not an Olmo turn.
export const brandFillAgent = new Agent({
  id: 'pc-brand-fill',
  name: 'Brand Fill',
  instructions: `You read what a brand publishes about itself and describe the brand for the people who will write its ads.
Rules:
- Use only what the material shows. Never invent facts, awards, prices or claims.
- oneLiner: one plain sentence saying what the brand makes or sells. No marketing language.
- audience: who the brand is for, in plain words (age range, place, need) as the material suggests.
- region: IN, US, UK, AE, SG or GLOBAL, from the domain, currency, language and places mentioned. If unsure, IN.
- toneWords: 3 to 5 single adjectives for how the brand sounds.
- emojiPolicy: none, minimal, moderate or expressive, from how its own copy uses emoji.
- signaturePhrases: short phrases the brand repeats about itself, copied exactly as written. Leave empty if none repeat.
- ctaExamples: calls to action exactly as the brand writes them (button text, "comment X for the link").
- voiceNotes: one markdown string (not an object) with a few short bullets under "## What we say" and "## What we avoid".
- name: always give the brand's name as the brand writes it.
- colors: hex values (#RRGGBB) for primary, secondary, accent, text, background, muted. Prefer the CSS colours and theme colour given; otherwise read them from the logo image. Leave a role as "" when unknown.
- headlineFont: the first real font family given, else "".
- Use "" or [] for anything the material does not show.`,
  tools: {},
  model: liteModel,
})

// String enums only: Gemini rejects numeric enums in response schemas.
// Forgiving on purpose: a missing field or an odd shape must not fail the whole import
// (the first live run lost a good fill because Gemini omitted `name` and returned
// voiceNotes as an object of sections). Missing text becomes "", bad enums fall back,
// and the API's merge already skips empty values.
const text = z.string().catch('')
const textList = z.array(z.string()).catch([])

/** {"What we say": ["a","b"], "What we avoid": "c"} → "## What we say\n- a\n- b\n\n## What we avoid\n- c" */
function notesToMarkdown(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.entries(value as Record<string, unknown>)
    .map(([heading, body]) => {
      const items = (Array.isArray(body) ? body : [body]).filter((b): b is string => typeof b === 'string' && b.trim() !== '')
      return `## ${heading}\n${items.map((i) => `- ${i}`).join('\n')}`
    })
    .join('\n\n')
}

export const brandFillOutputSchema = z.object({
  name: text,
  oneLiner: text,
  audience: text,
  region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']).catch('IN'),
  toneWords: textList,
  emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']).catch('minimal'),
  signaturePhrases: textList,
  ctaExamples: textList,
  voiceNotes: z.preprocess(notesToMarkdown, z.string()).catch(''),
  colors: z.object({
    primary: text, secondary: text, accent: text,
    text: text, background: text, muted: text,
  }).catch({ primary: '', secondary: '', accent: '', text: '', background: '', muted: '' }),
  headlineFont: text,
})

export type BrandFillOutput = z.infer<typeof brandFillOutputSchema>

// Mirrors products/agent-platform/packages/api/lib/brandSchema.ts's brandFillSchema limits
// (kept in sync by hand — the two packages can't import each other). That schema's array
// items are z.string().max(N) with no catch, so an over-length model value would fail the
// whole /import-result POST, not just drop that one field. Truncating a single string field
// is safe (name/oneLiner/audience/voiceNotes/headlineFont — summaries, fine to shorten).
// Array items are dropped instead of truncated: signaturePhrases and ctaExamples must stay
// verbatim or not appear at all, never cut mid-phrase.
const LIMITS = {
  name: 80, oneLiner: 200, audience: 300, voiceNotes: 3000, headlineFont: 60,
  toneWordItem: 30, toneWordCount: 5,
  signaturePhraseItem: 80, signaturePhraseCount: 10,
  ctaExampleItem: 80, ctaExampleCount: 10,
}

const truncate = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s)
const dropOverLong = (items: string[], maxLen: number, maxCount: number) =>
  items.filter((i) => i.length <= maxLen).slice(0, maxCount)

/** Clamps a fill agent's output to the API's brandFillSchema limits so the report POST can't be rejected. */
export function clampFill(fields: BrandFillOutput): BrandFillOutput {
  return {
    ...fields,
    name: truncate(fields.name, LIMITS.name),
    oneLiner: truncate(fields.oneLiner, LIMITS.oneLiner),
    audience: truncate(fields.audience, LIMITS.audience),
    voiceNotes: truncate(fields.voiceNotes, LIMITS.voiceNotes),
    headlineFont: truncate(fields.headlineFont, LIMITS.headlineFont),
    toneWords: dropOverLong(fields.toneWords, LIMITS.toneWordItem, LIMITS.toneWordCount),
    signaturePhrases: dropOverLong(fields.signaturePhrases, LIMITS.signaturePhraseItem, LIMITS.signaturePhraseCount),
    ctaExamples: dropOverLong(fields.ctaExamples, LIMITS.ctaExampleItem, LIMITS.ctaExampleCount),
  }
}

const list = (label: string, items: string[]) => (items.length ? `${label}:\n${items.map((i) => `- ${i}`).join('\n')}` : '')

export function buildFillPrompt(input: { website?: WebsiteFacts; instagram?: InstagramFacts }): string {
  const parts: string[] = []
  const w = input.website
  if (w) {
    parts.push(
      `Website: ${w.url}`,
      w.siteName ? `Site name: ${w.siteName}` : '',
      w.title ? `Page title: ${w.title}` : '',
      w.description ? `Description: ${w.description}` : '',
      list('Headings', w.headings),
      list('Buttons and calls to action', w.ctas),
      w.themeColor ? `Theme colour: ${w.themeColor}` : '',
      list('CSS colours, most used first', w.cssColors),
      list('Fonts', w.fonts),
      w.bodyText ? `Page text:\n${w.bodyText}` : '',
    )
  }
  const ig = input.instagram
  if (ig) {
    parts.push(
      `Instagram: @${ig.handle}`,
      ig.fullName ? `Name: ${ig.fullName}` : '',
      ig.bio ? `Bio: ${ig.bio}` : '',
      ig.externalUrl ? `Link in bio: ${ig.externalUrl}` : '',
      list('Recent captions', ig.captions),
    )
  }
  parts.push('The attached image, if any, is the brand logo or profile picture.')
  return parts.filter(Boolean).join('\n\n')
}
