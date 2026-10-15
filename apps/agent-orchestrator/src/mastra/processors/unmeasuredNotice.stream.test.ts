// Real Mastra streaming (scripted model): the tool result reaches the processor and
// the reply the user sees starts with the notice.
import { it, expect } from 'vitest'
import { Agent } from '@mastra/core/agent'
import { createTool } from '@mastra/core/tools'
import { MockLanguageModelV3, simulateReadableStream } from 'ai/test'
import { z } from 'zod'
import { UnmeasuredNoticeProcessor, UNMEASURED_NOTICE } from './unmeasuredNotice.js'

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }
const finish = (reason: string) => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage })

function scripted() {
  let call = 0
  return new MockLanguageModelV3({
    doStream: async () => {
      call++
      const chunks = call === 1
        ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: 'c1', toolName: 'break_down_video', input: JSON.stringify({ url: 'https://www.youtube.com/shorts/x' }) }, finish('tool-calls')]
        : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Video Breakdown: Grok Bot' }, { type: 'text-end', id: 't' }, finish('stop')]
      return { stream: simulateReadableStream({ chunks: chunks as any }) }
    },
  })
}

const breakdown = createTool({ id: 'break_down_video', description: 'x', inputSchema: z.object({ url: z.string() }), execute: async () => ({ success: true, result: { watch_only: true, measured: false } }) })

it('a watch-only breakdown opens the streamed reply with the notice', async () => {
  const agent = new Agent({ id: 'notice-test', name: 'notice-test', instructions: 'x', model: scripted(), tools: { break_down_video: breakdown }, outputProcessors: [new UnmeasuredNoticeProcessor()] })
  const out = await agent.stream('break this down', { maxSteps: 3 })
  const text = await out.text
  expect(text.startsWith(UNMEASURED_NOTICE)).toBe(true)
  expect(text).toContain('Video Breakdown: Grok Bot')
})
