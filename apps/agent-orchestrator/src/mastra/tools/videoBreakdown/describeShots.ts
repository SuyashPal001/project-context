import { askGeminiVideo, parseModelJson, asObject } from './geminiVideo.js'
import type { FetchedVideo } from './fetchVideo.js'
import type { SoundResult } from './aiServiceClient.js'

export interface Shot { n: number; start_s: number; end_s: number; size?: string; angle?: string; movement?: string; subject: string; action: string; sound?: string; on_screen_text?: string | null; story_role?: string; checker_fix?: { subject: string } }

export async function describeShots(video: Pick<FetchedVideo, 'filePath' | 'youtubeUrl' | 'durationS'>, bounds: number[], sound: Pick<SoundResult, 'events' | 'rhythm'> | null, tenantId?: string, fetchImpl?: typeof fetch): Promise<{ shots: Shot[]; sound_arc: string }> {
  const list = bounds.slice(0, -1).map((b, i) => `${i + 1}. ${b.toFixed(2)}s - ${bounds[i + 1].toFixed(2)}s`).join('\n')
  const ev = sound ? [...sound.events.slice(0, 30).map((e) => `${e.kind} ${e.change_db}dB at ${e.at_s}s`), ...sound.rhythm.map((r) => `rhythm every ${r.every_s}s from ${r.from_s}s to ${r.to_s}s`)].join(', ') || 'none' : 'not measured'
  const prompt = `Exact shot boundaries (measured by tools — keep them, do not invent shots):
${list}
Measured loudness changes (exact — trust them over your own timing): ${ev}.
Describe EACH shot in order so it could be reshot for a different brand. Only what you see and hear in that window; write "unclear" if unsure; never invent brand or model names, numbers or times you cannot read. Use image-left/image-right for directions.
Return ONLY JSON: {"shots":[{"n":1,"start_s":0,"end_s":0,"size":"wide|medium|close-up|extreme close-up|insert|overhead","angle":"eye|high|low|top-down|dutch","movement":"static|push in|pull out|pan|tilt|track|handheld","subject":"","action":"","sound":"","on_screen_text":null,"story_role":"hook|setup|problem|build|climax|product|resolution|endcard"}],"sound_arc":""}`
  const { raw } = await askGeminiVideo({ video: video.youtubeUrl ? { youtubeUrl: video.youtubeUrl } : { filePath: video.filePath }, durationS: video.durationS, prompt, tenantId, agentId: 'describe-shots', fetchImpl })
  const o = asObject(parseModelJson(raw), 'shots')
  return { shots: Array.isArray(o.shots) ? (o.shots as Shot[]) : [], sound_arc: typeof o.sound_arc === 'string' ? o.sound_arc : '' }
}
