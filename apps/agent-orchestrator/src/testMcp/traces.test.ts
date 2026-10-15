import { describe, it, expect } from 'vitest'
import { readToolSpans, type ObservabilityLike } from './traces.js'

function fakeStore(): ObservabilityLike {
  const traces: Record<string, { traceId: string; spans: any[] }> = {
    't1': {
      traceId: 't1',
      spans: [
        { traceId: 't1', spanId: 's1', name: 'platformAgent', spanType: 'agent_run', startedAt: new Date('2026-10-15T10:00:00.000Z'), endedAt: new Date('2026-10-15T10:00:05.000Z') },
        { traceId: 't1', spanId: 's2', name: 'generate_image', spanType: 'tool_call', startedAt: new Date('2026-10-15T10:00:01.000Z'), endedAt: new Date('2026-10-15T10:00:03.000Z'), input: { prompt: 'a cat' }, output: 'x'.repeat(5000) },
        { traceId: 't1', spanId: 's3', name: 'model_generation', spanType: 'model_generation', startedAt: new Date('2026-10-15T10:00:01.500Z'), endedAt: new Date('2026-10-15T10:00:02.000Z') },
      ],
    },
    't2': {
      traceId: 't2',
      spans: [
        { traceId: 't2', spanId: 's4', name: 'gmail_send', spanType: 'mcp_tool_call', startedAt: new Date('2026-10-15T09:59:00.000Z'), endedAt: new Date('2026-10-15T09:59:02.000Z'), error: 'boom' },
      ],
    },
  }
  return {
    async listTraces(args) {
      expect(args.filters?.threadId).toBe('c1')
      return {
        spans: [
          { traceId: 't1' } as any,
          { traceId: 't2' } as any,
        ],
      } as any
    },
    async getTrace({ traceId }) {
      return (traces[traceId] as any) ?? null
    },
  }
}

describe('readToolSpans', () => {
  it('keeps only tool/agent spans, oldest first, with output truncated to 2000 chars', async () => {
    const result = await readToolSpans(fakeStore(), 'c1')

    expect(result.map((s) => s.name)).toEqual(['gmail_send', 'platformAgent', 'generate_image'])
    expect(result.map((s) => s.type)).toEqual(['mcp_tool_call', 'agent_run', 'tool_call'])

    const gmail = result[0]
    expect(gmail.error).toBe('boom')
    expect(gmail.durationMs).toBe(2000)

    const agent = result[1]
    expect(agent.durationMs).toBe(5000)
    expect(agent.input).toBeUndefined()

    const image = result[2]
    expect(image.durationMs).toBe(2000)
    expect(image.input).toBe(JSON.stringify({ prompt: 'a cat' }))
    expect(image.output).toHaveLength(2001)
    expect(image.output).toBe(`${'x'.repeat(2000)}…`)
  })

  it('drops traces getTrace cannot find', async () => {
    const store: ObservabilityLike = {
      async listTraces() {
        return { spans: [{ traceId: 'missing' } as any] } as any
      },
      async getTrace() {
        return null
      },
    }
    expect(await readToolSpans(store, 'c1')).toEqual([])
  })
})
