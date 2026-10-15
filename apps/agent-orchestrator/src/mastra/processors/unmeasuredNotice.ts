import type { Processor, ProcessOutputStreamArgs, ProcessOutputResultArgs } from '@mastra/core/processors'
import type { ChunkType } from '@mastra/core/stream'

// When a breakdown could not be measured (YouTube blocked our download, so only
// Gemini watched the link), the user must hear that before trusting its times or
// spending on a remake (spec §8a). The model dropped this warning in a live run
// (2026-10-15), so code guarantees it: the reply after such a tool result starts
// with this notice, live and in the saved message.
export const UNMEASURED_NOTICE =
  'Heads-up: YouTube blocked our download of this video, so the times, cuts and poses below are Gemini\'s estimates — nothing was measured. Upload the video file before we spend anything on a remake.'

const WATCH_ONLY = /"watch_only"\s*:\s*true/

function isWatchOnly(result: unknown): boolean {
  try { return WATCH_ONLY.test(JSON.stringify(result) ?? '') } catch { return false }
}


export class UnmeasuredNoticeProcessor implements Processor {
  readonly id = 'unmeasured-notice'

  async processOutputStream({ part, state }: ProcessOutputStreamArgs): Promise<ChunkType> {
    if (part.type === 'tool-result' && isWatchOnly(part.payload.result)) state.pending = true
    if (part.type === 'text-delta' && state.pending && !state.shown) {
      state.shown = true
      return { ...part, payload: { ...part.payload, text: `${UNMEASURED_NOTICE}\n\n${part.payload.text}` } }
    }
    return part
  }

  processOutputResult({ messages, state }: ProcessOutputResultArgs) {
    if (!state.pending) return messages
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    if (!last) return messages
    const parts = last.content.parts ?? []
    if (parts.some((p) => p.type === 'text' && p.text.includes(UNMEASURED_NOTICE))) return messages
    const first = parts.findIndex((p) => p.type === 'text')
    const next = first >= 0
      ? parts.map((p, i) => (i === first && p.type === 'text' ? { ...p, text: `${UNMEASURED_NOTICE}\n\n${p.text}` } : p))
      : [{ type: 'text' as const, text: UNMEASURED_NOTICE }, ...parts]
    return messages.map((m) => (m === last ? { ...m, content: { ...m.content, parts: next } } : m))
  }
}
