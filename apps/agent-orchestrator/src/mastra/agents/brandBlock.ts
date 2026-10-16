import type { TenantBrand } from '../brand/types.js'

const REGION_NAMES: Record<string, string> = {
  IN: 'India', US: 'United States', UK: 'United Kingdom', AE: 'UAE', SG: 'Singapore', GLOBAL: 'Global',
}
const EMOJI_RULES: Record<string, string> = {
  none: 'none — never use emoji',
  minimal: 'minimal — at most one per caption',
  moderate: 'moderate — up to three per caption',
  expressive: 'expressive — emoji are part of the voice',
}
const quoted = (items: string[]) => items.map((i) => `"${i}"`).join(', ')

const SETUP = `\n\n## Your brand
This workspace has no saved brand yet. When the user asks to set up their brand, or pastes their website or Instagram handle for that purpose, call import_brand with the link or handle and tell them it will appear on the Brand page in a minute. If they have neither, ask with ask_clarifying_questions, one question at a time: what the brand is called, who it is for, and how it should sound; save each answer with update_brand, then ask them to send their logo if they have one and save it with update_brand's logoFileId.`

/** Olmo's view of the saved brand. Appended last so the stable instructions stay a cacheable prefix. */
export function brandInstructionBlock(brand: TenantBrand | null): string {
  if (!brand?.name?.trim()) return SETUP
  const colours = Object.entries(brand.colors ?? {}).map(([role, hex]) => `${role} ${hex}`).join(', ')
  const lines = [
    `- Name: ${brand.name}`,
    brand.oneLiner && `- What it makes: ${brand.oneLiner}`,
    brand.audience && `- Audience: ${brand.audience}`,
    `- Region: ${REGION_NAMES[brand.region] ?? brand.region} (use its currency, festivals and language habits)`,
    brand.toneWords.length > 0 && `- Tone: ${brand.toneWords.join(', ')}`,
    `- Emoji: ${EMOJI_RULES[brand.emojiPolicy] ?? brand.emojiPolicy}`,
    brand.signaturePhrases.length > 0 && `- Phrases it owns: ${quoted(brand.signaturePhrases)}`,
    brand.bannedPhrases.length > 0 && `- Never use: ${quoted(brand.bannedPhrases)}`,
    brand.ctaExamples.length > 0 && `- Calls to action it uses: ${quoted(brand.ctaExamples)}`,
    colours && `- Colours: ${colours}`,
    brand.headlineFont && `- Headline font: ${brand.headlineFont}`,
    brand.logoFileId && `- Logo: saved. composite_end_card puts it on the end card automatically; pass noLogo: true only when the user asks for no logo on that ad.`,
  ].filter(Boolean)
  const notes = brand.voiceNotes?.trim() ? `\nVoice notes:\n${brand.voiceNotes.trim()}` : ''
  return `\n\n## Your brand
This is the workspace's saved brand. Follow it in every caption, script, image and video. If the user asks for something different for one piece of work ("no logo on this one", "use blue here"), do it for that piece only; that never changes the saved brand.
${lines.join('\n')}${notes}
When the user states a lasting brand fact (its name, audience, tone, phrases to use or avoid, colours, logo), save it with update_brand. When they paste a website or Instagram handle to refresh the brand, call import_brand.`
}
