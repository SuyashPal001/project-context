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
    expect(r.state).toBe('not_tracked')
    expect(r.text).toContain('saved reply')
  })

  it('marks the run error when the /api/chat fetch itself throws, and lets the next send through', async () => {
    let calls = 0
    const f = vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/chat')) {
        calls++
        if (calls === 1) throw new Error('connect ECONNREFUSED 127.0.0.1:3001')
        return sseResponse([ev('done', { text: 'second' })])
      }
      return new Response('{}')
    })
    const d = new ChatDriver(identity, cfg, f as any)
    const r = await d.send({ conversationId: 'c-throw', message: 'a', waitSeconds: 1 })
    expect(r.state).toBe('error')
    expect(r.error).toMatch(/ECONNREFUSED/)
    expect((await d.read('c-throw', 0)).state).toBe('error')
    const r2 = await d.send({ conversationId: 'c-throw', message: 'b', waitSeconds: 1 })
    expect(r2.state).toBe('done')
  })

  it('a stream that closes without done ends as ended', async () => {
    const d = new ChatDriver(identity, cfg, fetchWith(sseResponse([ev('delta', { text: 'partial' })])) as any)
    const r = await d.send({ conversationId: 'c-early', message: 'a', waitSeconds: 1 })
    expect(r.state).toBe('ended')
    expect(r.text).toBe('partial')
  })

  // The server can finish the turn while the answer POST is still in flight
  // (a confirm declined without a reason emits done and closes at once).
  function gatedChat(first: string, afterAnswer: string, close = true) {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const enc = new TextEncoder()
    const chat = new Response(new ReadableStream({ async start(c) {
      c.enqueue(enc.encode(first))
      await gate
      c.enqueue(enc.encode(afterAnswer)); if (close) c.close()
    } }))
    return { chat, release }
  }

  it('keeps a done that arrives while the answer POST is in flight', async () => {
    const { chat, release } = gatedChat(ev('generation_confirm_request', { confirmationId: 'k1', label: 'Video' }), ev('done', { text: 'cancelled' }))
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/api/chat')) return chat
      if (u.endsWith('/api/chat/generation-confirm')) { release(); await new Promise((r) => setTimeout(r, 30)); return new Response('{}') }
      return fetchWith(chat)(u, init)
    })
    const d = new ChatDriver(identity, cfg, f as any)
    expect((await d.send({ conversationId: 'c-race', message: 'go', waitSeconds: 1 })).state).toBe('waiting')
    const r = await d.answer('c-race', { kind: 'confirm', decision: 'declined' }, 0.3)
    expect(r.state).toBe('done')
    expect(r.pending).toBeUndefined()
  })

  it('keeps a follow-up card that arrives while the answer POST is in flight', async () => {
    const { chat, release } = gatedChat(
      ev('approval_request', { approvalId: 'p1', toolName: 'x' }),
      ev('turn_resume', {}) + ev('approval_request', { approvalId: 'p2', toolName: 'y' }),
      false, // a waiting card keeps the stream open
    )
    const f = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.endsWith('/api/chat')) return chat
      if (u.endsWith('/api/chat/approval')) { release(); await new Promise((r) => setTimeout(r, 30)); return new Response('{}') }
      return new Response('{}')
    })
    const d = new ChatDriver(identity, cfg, f as any)
    await d.send({ conversationId: 'c-race2', message: 'go', waitSeconds: 1 })
    const r = await d.answer('c-race2', { kind: 'approval', decision: 'allow' }, 0.3)
    expect(r.state).toBe('waiting')
    expect(r.pending).toMatchObject({ kind: 'approval', id: 'p2' })
  })

  it('restores the card when the answer POST fails', async () => {
    const chat = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev('approval_request', { approvalId: 'p1' }))) } }))
    const f = fetchWith(chat, (u) => u.endsWith('/api/chat/approval') ? new Response('nope', { status: 500 }) : undefined)
    const d = new ChatDriver(identity, cfg, f as any)
    await d.send({ conversationId: 'c-fail', message: 'go', waitSeconds: 1 })
    await expect(d.answer('c-fail', { kind: 'approval', decision: 'allow' }, 0)).rejects.toThrow(/500/)
    const r = await d.read('c-fail', 0)
    expect(r.state).toBe('waiting')
    expect(r.pending).toMatchObject({ kind: 'approval', id: 'p1' })
  })

  it('answering after the stream already closed hands olmo_read to the saved messages', async () => {
    const f = fetchWith(new Response(''), (u) => {
      if (u.endsWith('/api/chat')) return sseResponse([ev('upload_request', { uploadId: 'u1', prompt: 'logo?' })])
      if (u.endsWith('/api/chat/upload')) return new Response('{}')
      if (u.endsWith('/api/v1/conversations/c-dead/messages')) return new Response(JSON.stringify({ data: [{ role: 'assistant', content: 'finished later' }] }))
    })
    const d = new ChatDriver(identity, cfg, f as any)
    await d.send({ conversationId: 'c-dead', message: 'go', waitSeconds: 1 })
    await vi.waitFor(async () => expect((await d.read('c-dead', 0)).state).toBe('ended'))
    const r1 = await d.read('c-dead', 0)
    expect(r1.pending).toMatchObject({ kind: 'upload', id: 'u1' })
    await d.answer('c-dead', { kind: 'upload', skipped: true }, 0)
    const r2 = await d.read('c-dead', 0)
    expect(r2.state).toBe('not_tracked')
    expect(r2.text).toContain('finished later')
    await expect(d.send({ conversationId: 'c-dead', message: 'next', waitSeconds: 0 })).resolves.toBeDefined()
  })

  it('refuses a partial answer to a multi-question card before posting anything', async () => {
    const chat = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev('clarification_request', { clarificationId: 'q1', questions: [{ prompt: 'A?' }, { prompt: 'B?' }] }))) } }))
    const f = fetchWith(chat)
    const d = new ChatDriver(identity, cfg, f as any)
    await d.send({ conversationId: 'c-multi', message: 'go', waitSeconds: 1 })
    await expect(d.answer('c-multi', { kind: 'question', answers: [{ questionIndex: 0, selectedIndex: 0 }] }, 0))
      .rejects.toThrow(/card has 2 questions; answer all of them, use skipped:true for any to skip/)
    expect(f.mock.calls.some(([u]) => String(u).endsWith('/api/chat/clarification'))).toBe(false)
    expect((await d.read('c-multi', 0)).pending).toMatchObject({ kind: 'question', id: 'q1' })
  })

  it('sends isFirstMessage true for the first message of a conversation made by newConversation, then false', async () => {
    let n = 0
    const f = fetchWith(new Response(''), (u) => u.endsWith('/api/chat') ? sseResponse([ev('done', { text: `r${++n}` })]) : undefined)
    const d = new ChatDriver(identity, cfg, f as any)
    const id = await d.newConversation()
    await d.send({ conversationId: id, message: 'one', waitSeconds: 1 })
    await d.send({ conversationId: id, message: 'two', waitSeconds: 1 })
    await d.send({ conversationId: 'c-old', message: 'three', waitSeconds: 1 })
    const bodies = f.mock.calls.filter(([u]) => String(u).endsWith('/api/chat')).map(([, i]) => JSON.parse(String(i!.body)).isFirstMessage)
    expect(bodies).toEqual([true, false, false])
  })
})
