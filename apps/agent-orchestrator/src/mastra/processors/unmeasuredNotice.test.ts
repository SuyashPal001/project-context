import { it, expect } from 'vitest'
import { UnmeasuredNoticeProcessor, UNMEASURED_NOTICE } from './unmeasuredNotice.js'

const p = new UnmeasuredNoticeProcessor()
const text = (t: string) => ({ type: 'text-delta', payload: { id: '1', text: t } }) as any
const toolResult = (result: unknown) => ({ type: 'tool-result', payload: { toolCallId: 'c', toolName: 'break_down_video', result } }) as any
const run = async (parts: any[]) => { const state: Record<string, unknown> = {}; const out: any[] = []; for (const part of parts) out.push(await p.processOutputStream({ part, state } as any)); return { out, state } }

it('puts the notice at the start of the reply after a watch-only breakdown', async () => {
  const { out } = await run([toolResult({ success: true, result: { watch_only: true, overview: {} } }), text('Video Breakdown: '), text('Grok Bot')])
  expect(out[1].payload.text.startsWith(UNMEASURED_NOTICE)).toBe(true)
  expect(out[2].payload.text).toBe('Grok Bot')
})

it('finds it inside a delegate\'s answer too (Director ran the breakdown)', async () => {
  const { out } = await run([{ type: 'tool-result', payload: { toolCallId: 'd', toolName: 'agent-director', result: { text: 'done', toolResults: [{ result: { watch_only: true } }] } } }, text('Here it is')])
  expect(out[1].payload.text.startsWith(UNMEASURED_NOTICE)).toBe(true)
})

it('leaves a measured breakdown alone', async () => {
  const { out } = await run([toolResult({ success: true, result: { watch_only: false, measured: true } }), text('Here it is')])
  expect(out[1].payload.text).toBe('Here it is')
})

it('adds the notice to the saved reply when the turn ends without text, or the stream copy was not kept', async () => {
  const state = { pending: true }
  const messages = [{ role: 'assistant', content: { parts: [{ type: 'text', text: 'Video Breakdown' }] } }] as any
  const out = (await p.processOutputResult({ messages, state } as any)) as any[]
  expect(out[0].content.parts[0].text.startsWith(UNMEASURED_NOTICE)).toBe(true)
  const again = (await p.processOutputResult({ messages: out, state } as any)) as any[]
  expect(again[0].content.parts[0].text.split(UNMEASURED_NOTICE).length).toBe(2)   // never twice
})
