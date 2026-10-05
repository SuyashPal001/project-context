const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'

// A mispronounced word is invisible to Gemini's transcript: it hears the word
// it expects ("bright" said as "briny" came back "bright" under every prompt,
// 2026-10-05). Two steps catch it instead:
//   1. Chirp writes literally what was said, knowing nothing of the script.
//   2. Each word it heard differently is put to Gemini as a choice between the
//      two words ("which did the speaker say?"), which clears Chirp's own slips
//      (it hears "tee" as "tea", "chalky" as "choki").
// Tested on 9 clips: the "briny" clip failed both times, the 8 clean clips passed.

const MODEL = 'gemini-3.6-flash'
const MAX_SUSPECTS = 3

const words = (s: string) => s.toLowerCase().replace(/<[^>]+>/g, ' ').replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)

/** A rough sound key: words that sound the same ("tee"/"tea") share it. */
export function soundKey(word: string): string {
  const w = word.toLowerCase()
    .replace(/ph/g, 'f').replace(/ch|sh/g, 'x').replace(/ck/g, 'k').replace(/wh/g, 'w').replace(/gh/g, '').replace(/^kn/, 'n')
    .replace(/c(?=[eiy])/g, 's').replace(/[cq]/g, 'k').replace(/z/g, 's').replace(/x(?!$)/g, 'x')
    .replace(/(.)\1+/g, '$1')
  return w[0] + w.slice(1).replace(/[aeiouyhw]/g, '')
}

function harmless(meant: string, heard: string): boolean {
  if (meant === heard || soundKey(meant) === soundKey(heard)) return true
  if (/\d/.test(meant) || /\d/.test(heard)) return true // "10" vs "ten", "grams" vs "g" next to a number
  if (heard.length <= 2 && meant.startsWith(heard)) return true // unit abbreviations: g, kg, ml
  const stem = (w: string) => w.replace(/(e?s|e?d)$/, '').replace(/e$/, '')
  return stem(meant) === stem(heard)
}

export interface SuspectWord { meant: string; heard: string; context: string }

/** Words of the approved line that the literal transcript heard as a different word. */
export function suspectWords(expected: string, heard: string): SuspectWord[] {
  const a = words(expected), b = words(heard)
  // Longest common subsequence alignment, then read off the replaced stretches.
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  }
  const out: SuspectWord[] = []
  let i = 0, j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue }
    const i0 = i, j0 = j
    while (i < a.length && j < b.length && a[i] !== b[j]) {
      if (dp[i + 1][j] >= dp[i][j + 1]) i++
      else j++
    }
    const gone = a.slice(i0, i), came = b.slice(j0, j)
    if (gone.length === 0 || came.length === 0) continue // a dropped or added word: the line check covers it
    const pairs: Array<[string, string]> = gone.length === came.length
      ? gone.map((w, k) => [w, came[k]])
      : [[gone.join(' '), came.join(' ')]]
    pairs.forEach(([meant, got], k) => {
      if (harmless(meant.replace(/ /g, ''), got.replace(/ /g, ''))) return
      const at = i0 + (gone.length === came.length ? k : 0)
      out.push({ meant, heard: got, context: [...a.slice(Math.max(0, at - 5), at), '___'].join(' ') })
    })
  }
  return out.slice(0, MAX_SUSPECTS)
}

async function askWhichWord(audioWav: string, s: SuspectWord, signal: AbortSignal): Promise<string | null> {
  const question = `Listen to the audio. In the part "${s.context}", which sound did the speaker actually make for the blank: "${s.meant}" or "${s.heard}"? Judge the sound only, not which word makes sense. If it sounds like neither clearly, say "unclear". Reply ONLY JSON {"said":"${s.meant}"|"${s.heard}"|"unclear"}`
  const res = await fetch(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
    body: JSON.stringify({ model: MODEL, temperature: 0, max_tokens: 2000, messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: audioWav, format: 'wav' } }, { type: 'text', text: question }] }] }),
  })
  if (!res.ok) return null
  const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const said = /"said"\s*:\s*"([^"]*)"/.exec(body.choices?.[0]?.message?.content ?? '')?.[1]
  return said?.toLowerCase().trim() ?? null
}

/** Words the speaker said wrongly, confirmed by both models; null when the check could not run. */
export async function mispronouncedWords(audioWav: string, expectedLine: string, signal: AbortSignal): Promise<SuspectWord[] | null> {
  try {
    const res = await fetch(`${INFERENCE_GATEWAY_URL}/v1/audio/literal-transcript`, {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' },
      body: JSON.stringify({ audioBase64: audioWav }),
    })
    if (!res.ok) return null
    const body = await res.json() as { text?: string }
    if (typeof body.text !== 'string' || !body.text) return null
    const suspects = suspectWords(expectedLine, body.text)
    const confirmed: SuspectWord[] = []
    for (const s of suspects) {
      const said = await askWhichWord(audioWav, s, signal)
      if (said === s.heard.toLowerCase()) confirmed.push(s)
    }
    return confirmed
  } catch (err) {
    console.error('[checkClip] pronunciation check skipped:', (err as Error).message)
    return null
  }
}
