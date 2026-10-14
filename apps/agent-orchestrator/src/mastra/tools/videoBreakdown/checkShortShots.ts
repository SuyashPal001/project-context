import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseModelJson, asObject } from './geminiVideo.js'
import { persistCost } from '../../cost.js'
import type { Shot } from './describeShots.js'

const execFile = promisify(execFileCb)
const INFERENCE_GATEWAY_URL = process.env.INFERENCE_GATEWAY_URL ?? 'http://localhost:4001'
const MAX_LEN_S = 1.0

export async function checkShortShots(video: { filePath: string }, shots: Shot[], tenantId?: string, fetchImpl: typeof fetch = fetch): Promise<{ checked: number; status: 'ok' | 'unknown'; fixes: Array<{ n: number; subject: string }> }> {
  const short = shots.filter((s) => s.end_s - s.start_s < MAX_LEN_S && s.subject !== 'unclear')
  if (short.length === 0) return { checked: 0, status: 'ok', fixes: [] }
  const model = process.env.SHOT_CHECK_MODEL ?? 'openrouter/openai/gpt-6-sol'
  const dir = mkdtempSync(join(tmpdir(), 'shotcheck-'))
  try {
    const content: Array<Record<string, unknown>> = []
    for (const s of short) {
      const p = join(dir, `${s.n}.jpg`)
      await execFile('ffmpeg', ['-v', 'error', '-y', '-ss', String((s.start_s + s.end_s) / 2), '-i', video.filePath, '-frames:v', '1', '-vf', 'scale=480:-1', p], { timeout: 30_000 })
      content.push({ type: 'text', text: `Shot ${s.n} (${s.start_s}-${s.end_s}s): claimed subject "${s.subject}"` })
      content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${readFileSync(p).toString('base64')}` } })
    }
    content.push({ type: 'text', text: 'Each image is the middle frame of one short shot. Is the claimed SUBJECT (who/what is in the frame) right? Judge only the subject, not motion. Return ONLY JSON: [{"n":shot number,"ok":true|false,"subject":"corrected subject if wrong"}]' })
    const res = await fetchImpl(`${INFERENCE_GATEWAY_URL}/v1/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(120_000), headers: { 'Content-Type': 'application/json', 'x-internal-service-key': process.env.INTERNAL_SERVICE_KEY ?? '' }, body: JSON.stringify({ model, temperature: 0, max_tokens: 2000, messages: [{ role: 'user', content }] }) })
    if (!res.ok) return { checked: short.length, status: 'unknown', fixes: [] }
    const json = await res.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    if (tenantId && json.usage) persistCost({ tenantId, agentId: 'check-short-shots', workflowId: 'video-breakdown', model, inputTokens: json.usage.prompt_tokens ?? 0, outputTokens: json.usage.completion_tokens ?? 0 })
    const verdicts = asObject(parseModelJson(json.choices?.[0]?.message?.content ?? ''), 'verdicts').verdicts as Array<{ n: number | string; ok?: boolean; subject?: string }> | undefined
    if (!Array.isArray(verdicts)) return { checked: short.length, status: 'unknown', fixes: [] }
    const byN = new Map(verdicts.map((v) => [Number(v.n), v]))
    // Partial answers are not a pass (review M4).
    if (short.some((s) => !byN.has(s.n))) return { checked: short.length, status: 'unknown', fixes: [] }
    const fixes = short.map((s) => byN.get(s.n)!).filter((v) => v.ok === false && typeof v.subject === 'string' && v.subject).map((v) => ({ n: Number(v.n), subject: v.subject as string }))
    return { checked: short.length, status: 'ok', fixes }
  } catch {
    return { checked: short.length, status: 'unknown', fixes: [] }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
