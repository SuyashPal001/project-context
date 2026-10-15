import { describe, it, expect, vi } from 'vitest'
import { ChatDriver } from './chatDriver.js'

const cfg = { port: 3007, tenantId: 't1', agentId: 'a1', email: '', password: '', cognitoClientId: '', cognitoRegion: '', selfBaseUrl: 'http://127.0.0.1:3001', apiBaseUrl: 'https://api.example' }
const identity = { idToken: async () => 'tok', userSub: 'sub1', internalUserId: 'u1' } as any

function sseResponse(blocks: string[]): Response {
  const enc = new TextEncoder()
  return new Response(new ReadableStream({ start(c) { for (const b of blocks) c.enqueue(enc.encode(b)); c.close() } }))
}
const ev = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`

function fetchWith(chat: Response, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url)
    const x = extra(u, init); if (x) return x
    if (u.endsWith('/api/v1/conversations') && init?.method === 'POST') return new Response(JSON.stringify({ data: { id: 'c-new' } }))
    if (u.includes('/api/v1/conversations/') && init?.method === 'PATCH') return new Response('{}')
    if (u.endsWith('/api/chat')) return chat
    return new Response('{}')
  })
}

describe('ChatDriver', () => {
  it('creates an auto-mode conversation and runs a turn to done', async () => {
    const f = fetchWith(sseResponse([ev('delta', { text: 'Hello' }), ev('tool_call', { toolName: 'agent-director' }), ev('tool_done', { toolName: 'agent-director', result: {} }), ev('done', { text: 'Hello', attachments: [{ fileId: 'f1', name: 'a.mp4', type: 'video/mp4' }] })]))
    const d = new ChatDriver(identity, cfg, f as any)
    const r = await d.send({ message: 'hi', waitSeconds: 2 })
    expect(r.conversationId).toBe('c-new')
    expect(r.state).toBe('done')
    expect(r.files[0].fileId).toBe('f1')
    const patch = f.mock.calls.find(([, i]) => i?.method === 'PATCH')!
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ allowMode: 'auto' })
    const chat = f.mock.calls.find(([u]) => String(u).endsWith('/api/chat'))!
    expect(JSON.parse(String(chat[1]!.body))).toMatchObject({ conversationId: 'c-new', message: 'hi', agentId: 'a1', allowMode: 'auto' })
  })

  it('stops at a question and answers it through /api/chat/clarification with a fresh X-Id-Token', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const enc = new TextEncoder()
    const chat = new Response(new ReadableStream({ async start(c) {
      c.enqueue(enc.encode(ev('clarification_request', { clarificationId: 'q1', questions: [{ prompt: 'Lang?', options: [{ label: 'EN' }] }] })))
      await gate
      c.enqueue(enc.encode(ev('turn_resume', {}) + ev('done', { text: 'ok' }))); c.close()
    } }))
    const f = fetchWith(chat, (u) => { if (u.endsWith('/api/chat/clarification')) { release(); return new Response(JSON.stringify({ ok: true, remaining: 0 })) } })
    const d = new ChatDriver(identity, cfg, f as any)
    const r1 = await d.send({ conversationId: 'c1', message: 'make video', waitSeconds: 2 })
    expect(r1.state).toBe('waiting')
    expect(r1.pending).toMatchObject({ kind: 'question', id: 'q1' })
    const r2 = await d.answer('c1', { kind: 'question', answers: [{ questionIndex: 0, selectedIndex: 0 }] }, 2)
    expect(r2.state).toBe('done')
    const post = f.mock.calls.find(([u]) => String(u).endsWith('/api/chat/clarification'))!
    expect((post[1]!.headers as Record<string, string>)['X-Id-Token']).toBe('tok')
    expect(JSON.parse(String(post[1]!.body))).toEqual({ clarificationId: 'q1', questionIndex: 0, selectedIndex: 0 })
  })

  it('refuses a second send while a turn is running', async () => {
    const chat = new Response(new ReadableStream({ start() { /* never ends */ } }))
    const d = new ChatDriver(identity, cfg, fetchWith(chat) as any)
    await d.send({ conversationId: 'c2', message: 'a', waitSeconds: 0.1 })
    await expect(d.send({ conversationId: 'c2', message: 'b', waitSeconds: 0.1 })).rejects.toThrow(/turn still running/)
  })

  it('falls back to saved messages after a restart', async () => {
    const f = fetchWith(new Response(''), (u) => u.endsWith('/api/v1/conversations/c9/messages')
      ? new Response(JSON.stringify({ data: [{ role: 'assistant', content: 'saved reply' }] })) : undefined)
    const r = await new ChatDriver(identity, cfg, f as any).read('c9', 0)
    expect(r.state).toBe('unknown_after_restart')
    expect(r.text).toContain('saved reply')
  })
})
