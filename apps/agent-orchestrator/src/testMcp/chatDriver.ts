// Route 2 of the internal test MCP: a headless copy of the web chat client.
// It posts to the orchestrator's own /api/chat with the test user's real id
// token, keeps reading the SSE stream in the background, and answers cards
// through the same routes the web cards call. Claude then plays the user end
// to end. A test run is the same code path as a person typing in the app.
import type { TestMcpConfig } from './config.js'
import type { TestIdentity } from './testIdentity.js'
import { SseParser } from './sse.js'

export type Pending =
  | { kind: 'question'; id: string; questions: unknown }
  | { kind: 'confirm'; id: string; label?: string; subject?: string }
  | { kind: 'approval'; id: string; toolName?: string }
  | { kind: 'upload'; id: string; prompt?: string }
// 'not_tracked': this process holds no live run for the conversation (it
// restarted, never drove it, or let go of a run whose stream had closed), so
// the result comes from the saved messages.
export type RunState = 'running' | 'waiting' | 'done' | 'error' | 'ended' | 'not_tracked'
export type ReadResult = {
  conversationId: string; state: RunState; pending?: Pending; text: string
  toolCalls: Array<{ toolName: string; ok: boolean }>
  files: Array<{ fileId: string; name?: string; type?: string }>
  newEvents: number; error?: string
}
export type Answer =
  | { kind: 'question'; answers: Array<{ questionIndex: number; selectedIndex?: number; selectedIndices?: number[]; freeText?: string; skipped?: boolean }> }
  | { kind: 'confirm'; decision: 'approved' | 'declined'; reason?: string }
  | { kind: 'approval'; decision: 'allow' | 'deny' }
  | { kind: 'upload'; fileIds?: string[]; freeText?: string; skipped?: boolean }

type Run = {
  state: RunState; pending?: Pending; text: string; error?: string
  toolCalls: ReadResult['toolCalls']; files: ReadResult['files']
  events: number; readCursor: number; changed: () => void; waiters: Array<() => void>
}

const MAX_WAIT_S = 240

export class ChatDriver {
  private runs = new Map<string, Run>()
  // Made by newConversation() and not yet sent to: their first send must say
  // isFirstMessage so the chat gets its title, like a fresh web chat.
  private unsent = new Set<string>()
  constructor(private id: TestIdentity, private cfg: TestMcpConfig, private fetchImpl: typeof fetch = fetch) {}

  async send(a: { conversationId?: string; message: string; fileIds?: string[]; waitSeconds?: number }): Promise<ReadResult> {
    const existing = a.conversationId ? this.runs.get(a.conversationId) : undefined
    if (existing && (existing.state === 'running' || existing.state === 'waiting')) {
      throw new Error('turn still running; use olmo_read, or olmo_answer if it is waiting')
    }
    const conversationId = a.conversationId ?? await this.newConversation()
    const token = await this.id.idToken()
    const run = this.newRun()
    this.runs.set(conversationId, run)
    const isFirstMessage = this.unsent.delete(conversationId) || !a.conversationId
    let res: Response
    try {
      res = await this.fetchImpl(`${this.cfg.selfBaseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Id-Token': token, Accept: 'text/event-stream' },
        body: JSON.stringify({
          conversationId, message: a.message, agentId: this.cfg.agentId, allowMode: 'auto',
          attachments: (a.fileIds ?? []).map((fileId) => ({ fileId })),
          isFirstMessage,
        }),
      })
    } catch (err) {
      // No stream will ever update this run; leaving it 'running' would wedge
      // the conversation (every later send refused, every read 'running').
      run.state = 'error'; run.error = `chat request failed: ${(err as Error).message}`
      return this.snapshot(conversationId, run)
    }
    if (!res.ok || !res.body) {
      run.state = 'error'; run.error = `chat ${res.status}: ${await res.text().catch(() => '')}`
      return this.snapshot(conversationId, run)
    }
    void this.pump(res.body, run)
    return this.wait(conversationId, run, a.waitSeconds)
  }

  async read(conversationId: string, waitSeconds = 0): Promise<ReadResult> {
    const run = this.runs.get(conversationId)
    if (!run) return this.fromSaved(conversationId)
    return this.wait(conversationId, run, waitSeconds)
  }

  async answer(conversationId: string, ans: Answer, waitSeconds?: number): Promise<ReadResult> {
    const run = this.runs.get(conversationId)
    if (!run?.pending) throw new Error('nothing is waiting for an answer in this conversation')
    if (run.pending.kind !== ans.kind) throw new Error(`waiting for a ${run.pending.kind} answer, got ${ans.kind}`)
    const p = run.pending
    // A partly answered card stays open server-side and the turn hangs.
    const asked = p.kind === 'question' && Array.isArray(p.questions) ? p.questions.length : 0
    if (ans.kind === 'question' && ans.answers.length < asked) {
      throw new Error(`card has ${asked} questions; answer all of them, use skipped:true for any to skip`)
    }
    const bodies = answerBodies(p, ans)
    const token = await this.id.idToken()
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Id-Token': token }
    // The stream already closed (ended/error) with the card still open: the
    // server keeps the card and continues the turn detached, but nothing will
    // update this run again.
    const streamOver = run.state === 'ended' || run.state === 'error'
    // Cleared before the POSTs, not after: the pump keeps applying events while
    // they are in flight, and a done or a follow-up card that lands then must
    // not be overwritten.
    run.pending = undefined
    if (!streamOver) run.state = 'running'
    for (const { path, body } of bodies) {
      const r = await this.fetchImpl(`${this.cfg.selfBaseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
      if (!r.ok) {
        if (run.pending === undefined && run.state === 'running') { run.pending = p; run.state = 'waiting' }
        else if (streamOver && run.pending === undefined) run.pending = p
        throw new Error(`${path} ${r.status}: ${await r.text().catch(() => '')}`)
      }
    }
    if (streamOver) {
      // Let go of the run so olmo_read falls back to the saved messages.
      if (this.runs.get(conversationId) === run) this.runs.delete(conversationId)
      return this.fromSaved(conversationId)
    }
    return this.wait(conversationId, run, waitSeconds)
  }

  // Public: the later `test_new_conversation` MCP tool calls this directly to
  // create a conversation without sending a first message (controller ruling —
  // the brief's own sketch had this private).
  async newConversation(): Promise<string> {
    const token = await this.id.idToken()
    const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    const c = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/v1/conversations`, { method: 'POST', headers: h, body: JSON.stringify({ agentId: this.cfg.agentId }) })
    const json = await c.json() as { data?: { id?: string } }
    const id = json.data?.id
    if (!c.ok || !id) throw new Error(`create conversation failed ${c.status}`)
    const p = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/v1/conversations/${id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ allowMode: 'auto' }) })
    if (!p.ok) throw new Error(`set auto mode failed ${p.status}`)
    this.unsent.add(id)
    return id
  }

  private newRun(): Run {
    const run: Run = { state: 'running', text: '', toolCalls: [], files: [], events: 0, readCursor: 0, waiters: [], changed: () => {} }
    run.changed = () => { const w = run.waiters.splice(0); w.forEach((f) => f()) }
    return run
  }

  private async pump(body: ReadableStream<Uint8Array>, run: Run): Promise<void> {
    const parser = new SseParser()
    const dec = new TextDecoder()
    const reader = body.getReader()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        for (const e of parser.push(dec.decode(value, { stream: true }))) { applyEvent(run, e.event, e.data as Record<string, any>); run.events++; run.changed() }
      }
    } catch (err) {
      run.state = 'error'; run.error = (err as Error).message
    }
    if (run.state === 'running' || run.state === 'waiting') run.state = 'ended'
    run.changed()
  }

  private async wait(conversationId: string, run: Run, waitSeconds = 45): Promise<ReadResult> {
    const ms = Math.min(Math.max(waitSeconds, 0), MAX_WAIT_S) * 1000
    if (run.state === 'running' && ms > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms)
        const check = () => { if (run.state !== 'running') { clearTimeout(t); resolve() } else run.waiters.push(check) }
        run.waiters.push(check)
      })
    }
    return this.snapshot(conversationId, run)
  }

  private snapshot(conversationId: string, run: Run): ReadResult {
    const newEvents = run.events - run.readCursor
    run.readCursor = run.events
    return { conversationId, state: run.state, pending: run.pending, text: run.text, toolCalls: run.toolCalls, files: run.files, newEvents, error: run.error }
  }

  private async fromSaved(conversationId: string): Promise<ReadResult> {
    const token = await this.id.idToken()
    const r = await this.fetchImpl(`${this.cfg.apiBaseUrl}/api/v1/conversations/${conversationId}/messages`, { headers: { Authorization: `Bearer ${token}` } })
    const json = r.ok ? await r.json() as { data?: Array<{ role?: string; content?: string }> } : { data: [] }
    const text = (json.data ?? []).filter((m) => m.role === 'assistant').map((m) => m.content ?? '').join('\n\n')
    return { conversationId, state: 'not_tracked', text, toolCalls: [], files: [], newEvents: 0 }
  }
}

function applyEvent(run: Run, event: string, d: Record<string, any>): void {
  switch (event) {
    case 'delta': run.text += d?.text ?? ''; break
    case 'tool_call': run.toolCalls.push({ toolName: String(d?.toolName ?? ''), ok: true }); break
    case 'tool_done': {
      const ok = !d?.result?.failed && !d?.result?.cancelled
      const open = [...run.toolCalls].reverse().find((t) => t.toolName === d?.toolName)
      if (open) open.ok = ok; else run.toolCalls.push({ toolName: String(d?.toolName ?? ''), ok })
      break
    }
    case 'clarification_request': run.state = 'waiting'; run.pending = { kind: 'question', id: d.clarificationId, questions: d.questions }; break
    case 'generation_confirm_request': run.state = 'waiting'; run.pending = { kind: 'confirm', id: d.confirmationId, label: d.label, subject: d.subject }; break
    case 'approval_request': run.state = 'waiting'; run.pending = { kind: 'approval', id: d.approvalId, toolName: d.toolName }; break
    case 'upload_request': run.state = 'waiting'; run.pending = { kind: 'upload', id: d.uploadId, prompt: d.prompt }; break
    case 'turn_resume': run.state = 'running'; run.pending = undefined; break
    case 'done':
      run.state = 'done'
      if (typeof d?.text === 'string' && d.text.length >= run.text.length) run.text = d.text
      run.files = Array.isArray(d?.attachments) ? d.attachments.map((a: any) => ({ fileId: a.fileId, name: a.name, type: a.type })) : []
      break
    case 'error': run.state = 'error'; run.error = String(d?.message ?? 'error'); break
  }
}

function answerBodies(p: Pending, a: Answer): Array<{ path: string; body: object }> {
  if (p.kind === 'question' && a.kind === 'question') {
    return a.answers.map((x) => ({ path: '/api/chat/clarification', body: { clarificationId: p.id, ...x } }))
  }
  if (p.kind === 'confirm' && a.kind === 'confirm') {
    return [{ path: '/api/chat/generation-confirm', body: { confirmationId: p.id, decision: a.decision, ...(a.reason ? { reason: a.reason } : {}) } }]
  }
  if (p.kind === 'approval' && a.kind === 'approval') {
    return [{ path: '/api/chat/approval', body: { approvalId: p.id, decision: a.decision } }]
  }
  if (p.kind === 'upload' && a.kind === 'upload') {
    return [{ path: '/api/chat/upload', body: { uploadId: p.id, files: (a.fileIds ?? []).map((fileId) => ({ fileId })), freeText: a.freeText, skipped: a.skipped === true } }]
  }
  throw new Error('answer kind does not match the pending card')
}
