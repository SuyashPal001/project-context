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
- voiceNotes: a few short markdown bullets under "## What we say" and "## What we avoid".
- colors: hex values (#RRGGBB) for primary, secondary, accent, text, background, muted. Prefer the CSS colours and theme colour given; otherwise read them from the logo image. Leave a role as "" when unknown.
- headlineFont: the first real font family given, else "".
- Use "" or [] for anything the material does not show.`,
  tools: {},
  model: liteModel,
})

// String enums only: Gemini rejects numeric enums in response schemas.
export const brandFillOutputSchema = z.object({
  name: z.string(),
  oneLiner: z.string(),
  audience: z.string(),
  region: z.enum(['IN', 'US', 'UK', 'AE', 'SG', 'GLOBAL']),
  toneWords: z.array(z.string()),
  emojiPolicy: z.enum(['none', 'minimal', 'moderate', 'expressive']),
  signaturePhrases: z.array(z.string()),
  ctaExamples: z.array(z.string()),
  voiceNotes: z.string(),
  colors: z.object({
    primary: z.string(), secondary: z.string(), accent: z.string(),
    text: z.string(), background: z.string(), muted: z.string(),
  }),
  headlineFont: z.string(),
})

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
