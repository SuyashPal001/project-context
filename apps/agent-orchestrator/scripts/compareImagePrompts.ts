/**
 * Side-by-side check of the director's image-prompt writing: OLD (no craft rules)
 * vs NEW (IMAGE_PROMPT_CRAFT appended, as directorAgent.ts now does).
 *
 * Runs against the live inference gateway, so run it on the VM where the gateway
 * and its keys exist. Text-only by default (cheap: a few small chat calls, no image
 * spend). With --generate it also renders BOTH prompts through /v1/images/generations
 * and saves PNGs (to the OS temp dir, not the repo), so you can look at the actual images. That goes straight to the
 * gateway — it does not touch tenant credits, but it does use Gemini image quota.
 *
 * Usage (from apps/agent-orchestrator):
 *   INTERNAL_SERVICE_KEY=... npx tsx scripts/compareImagePrompts.ts
 *   INTERNAL_SERVICE_KEY=... npx tsx scripts/compareImagePrompts.ts --generate
 *   ... --only 3           # just request #3 (1-based)
 *
 * The OLD side is a stand-in: the director had no plain-image craft guidance before,
 * so it is the same role line with nothing after it. Judge the two prompts and the
 * two images by eye; there is deliberately no automatic score.
 */
import 'dotenv/config'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { IMAGE_PROMPT_CRAFT } from '../src/mastra/agents/imagePromptCraft.js'

const GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY ?? ''
const CHAT_MODEL = process.env.MASTRA_MODEL ?? 'gemini-2.5-flash'
const IMAGE_MODEL = 'gemini-3-pro-image-preview'

const REQUESTS = [
  'generate a picture of a tvc character',
  'a red car',
  'generate an image of a slice of toast',
  'a cozy reading nook',
  'a poster for a coffee shop called Bean There with the tagline "Fresh every morning"',
  'product photo of a ceramic mug for an online shop',
]

const ROLE = 'You are Director — an image generation specialist. You create images from descriptions.'
const TASK = `\n\nThe user asked for an image. Write the exact prompt you would pass to the generate_image tool, and the aspectRatio you would set (one of 1:1, 3:4, 4:3, 9:16, 16:9). Reply in exactly this form and nothing else:\nASPECT: <ratio>\nPROMPT: <the prompt>`

const SYSTEMS = {
  old: ROLE + TASK,
  new: ROLE + IMAGE_PROMPT_CRAFT + TASK,
} as const

const headers = { 'Content-Type': 'application/json', 'x-internal-service-key': SERVICE_KEY }

async function writePrompt(system: string, request: string): Promise<{ aspect: string; prompt: string; raw: string }> {
  const res = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: CHAT_MODEL,
      temperature: 0.4,
      messages: [{ role: 'system', content: system }, { role: 'user', content: request }],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const raw = (json.choices?.[0]?.message?.content ?? '').trim()
  const aspect = /ASPECT:\s*([0-9]+:[0-9]+)/i.exec(raw)?.[1] ?? ''
  const prompt = /PROMPT:\s*([\s\S]+)$/i.exec(raw)?.[1]?.trim() ?? raw
  return { aspect, prompt, raw }
}

async function renderImage(prompt: string, aspectRatio: string): Promise<Buffer | null> {
  const res = await fetch(`${GATEWAY_URL}/v1/images/generations`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, ...(aspectRatio ? { aspectRatio } : {}) }),
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok) throw new Error(`image ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { imageBase64?: string; refused?: boolean; reason?: string }
  if (!json.imageBase64) {
    console.log(`   (no image: ${json.refused ? json.reason : 'empty response'})`)
    return null
  }
  return Buffer.from(json.imageBase64, 'base64')
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length

async function main() {
  if (!SERVICE_KEY) throw new Error('INTERNAL_SERVICE_KEY is required')
  const generate = process.argv.includes('--generate')
  const onlyArg = process.argv.indexOf('--only')
  const only = onlyArg >= 0 ? Number(process.argv[onlyArg + 1]) : null
  const outDir = join(tmpdir(), `image-prompt-compare-${Date.now()}`)
  if (generate) mkdirSync(outDir, { recursive: true })

  for (let i = 0; i < REQUESTS.length; i++) {
    if (only && only !== i + 1) continue
    const request = REQUESTS[i]
    console.log(`\n${'='.repeat(78)}\n#${i + 1}  ${request}\n${'='.repeat(78)}`)
    for (const side of ['old', 'new'] as const) {
      try {
        const { aspect, prompt } = await writePrompt(SYSTEMS[side], request)
        console.log(`\n[${side.toUpperCase()}]  aspect=${aspect || '(none)'}  words=${wordCount(prompt)}\n${prompt}`)
        if (generate) {
          const png = await renderImage(prompt, aspect)
          if (png) {
            const file = join(outDir, `${i + 1}-${side}.png`)
            writeFileSync(file, png)
            console.log(`   saved ${file}`)
          }
        }
      } catch (err) {
        console.log(`\n[${side.toUpperCase()}]  FAILED: ${(err as Error).message}`)
      }
    }
  }
  if (generate) console.log(`\nImages in ${outDir}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
