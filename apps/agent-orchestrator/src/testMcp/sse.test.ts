import { describe, it, expect } from 'vitest'
import { SseParser } from './sse.js'

describe('SseParser', () => {
  it('parses events split across chunks and drops heartbeats', () => {
    const p = new SseParser()
    expect(p.push('event: delta\ndata: {"te')).toEqual([])
    expect(p.push('xt":"Hi"}\n\n: heartbeat\n\nevent: done\ndata: {"text":"Hi"}\n\n')).toEqual([
      { event: 'delta', data: { text: 'Hi' } },
      { event: 'done', data: { text: 'Hi' } },
    ])
  })
  it('keeps non-JSON data as a string', () => {
    expect(new SseParser().push('event: x\ndata: plain\n\n')).toEqual([{ event: 'x', data: 'plain' }])
  })
})
