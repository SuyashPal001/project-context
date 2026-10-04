// Studio lighting words make an ad look like a set, and the image model draws
// them literally: 2026-10-05 a UGC brief said "natural gym softbox lighting"
// and the gym shot came back with a softbox lamp standing behind the presenter.
// In ad flows the tools take these words out of the prompt (outside quoted
// dialogue), whatever the brief said; a plain product photo outside an ad flow
// keeps them.
const STUDIO_LIGHT: Array<[RegExp, string]> = [
  [/\b(?:studio|three[- ]point|professional)\s+light(?:ing|s)?\b/gi, 'natural light'],
  [/\bsoft[- ]?box(?:es)?\s*/gi, ''],
  [/\bring[- ]?light(?:s)?\s*/gi, ''],
  [/\b(?:light\s+stands?|reflectors?)\b/gi, ''],
]

export function stripStudioLighting(prompt: string): string {
  // Leave quoted dialogue untouched: it must match the approved line exactly.
  return prompt.split(/("[^"]*"|“[^”]*”)/).map((part, i) => {
    if (i % 2 === 1) return part
    let out = part
    for (const [re, to] of STUDIO_LIGHT) out = out.replace(re, to)
    return out.replace(/ {2,}/g, ' ').replace(/\s+([,.])/g, '$1').replace(/,\s*,/g, ',')
  }).join('')
}
