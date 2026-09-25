import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { findPastTasksTool, scoreTask, summarizeTask } from '../findPastTasks.js'

interface Result {
    tasks: Array<{ taskId: string; title: string; employee: string; lastActive: string }>
    summary?: { taskId: string; title: string; brief: string; lastReplies: string[]; files: Array<{ fileId: string; name: string; type: string }>; messageCount: number }
    note?: string
}

async function run(input: Record<string, unknown>, execCtx: never): Promise<Result> {
    const out = await findPastTasksTool.execute!(input as never, execCtx)
    if (!out || !('tasks' in out)) throw new Error(`expected a result, got ${JSON.stringify(out)}`)
    return out as Result
}

const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
    return { requestContext } as never
}

const ID = {
    current: '00000000-0000-4000-8000-000000000001',
    redCar: '00000000-0000-4000-8000-000000000002',
    gym: '00000000-0000-4000-8000-000000000003',
    archived: '00000000-0000-4000-8000-000000000004',
}

const conversations = [
    { id: ID.current, title: 'Diwali banner', status: 'active', createdAt: '2026-09-25T10:00:00Z', updatedAt: '2026-09-25T10:00:00Z', agent: { name: 'Olmo' } },
    { id: ID.redCar, title: 'Red car Instagram ad', status: 'active', createdAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:00:00Z', lastMessage: { content: 'Here is your ad', createdAt: '2026-09-20T11:00:00Z' }, agent: { name: 'Olmo' } },
    { id: ID.gym, title: '30s gym reel script', status: 'active', createdAt: '2026-09-22T10:00:00Z', updatedAt: '2026-09-22T10:00:00Z', agent: { name: 'Olmo' } },
    { id: ID.archived, title: 'Red car old draft', status: 'archived', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-01T10:00:00Z', agent: { name: 'Olmo' } },
]

const redCarMessages = [
    { role: 'user', content: 'make a red car ad for instagram, bold, low angle', createdAt: '1' },
    { role: 'assistant', content: 'Here are 3 directions', createdAt: '2' },
    { role: 'tool', content: 'internal', createdAt: '3' },
    { role: 'assistant', content: 'Done — final image attached', attachments: [{ fileId: 'f-1', name: 'car.png', type: 'image/png', size: 1 }], createdAt: '4' },
]

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
    fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/v1/conversations')) return new Response(JSON.stringify({ data: conversations }))
        if (url.endsWith(`/api/v1/conversations/${ID.redCar}/messages`)) return new Response(JSON.stringify({ data: redCarMessages }))
        return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('find_past_tasks', () => {
    it('reads only through the user\'s own token', async () => {
        await run({ query: 'red car' }, ctx({ idToken: 'tok', conversationId: ID.current }))
        for (const [, init] of fetchMock.mock.calls) {
            expect((init as RequestInit).headers).toEqual({ Authorization: 'Bearer tok' })
        }
    })

    it('matches by title, skips the current and archived tasks, and summarizes the best match', async () => {
        const out = await run({ query: 'the red car ad' }, ctx({ idToken: 'tok', conversationId: ID.current }))
        expect(out.tasks.map(t => t.taskId)).toEqual([ID.redCar])
        expect(out.summary).toEqual({
            taskId: ID.redCar,
            title: 'Red car Instagram ad',
            brief: 'make a red car ad for instagram, bold, low angle',
            lastReplies: ['Here are 3 directions', 'Done — final image attached'],
            files: [{ fileId: 'f-1', name: 'car.png', type: 'image/png' }],
            messageCount: 3,
        })
    })

    it('lists recent tasks without reading any transcript when there is no query', async () => {
        const out = await run({}, ctx({ idToken: 'tok', conversationId: ID.current }))
        expect(out.tasks.map(t => t.title)).toEqual(['30s gym reel script', 'Red car Instagram ad'])
        expect(out.summary).toBeUndefined()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('says so when nothing matches', async () => {
        const out = await run({ query: 'sneaker launch' }, ctx({ idToken: 'tok' }))
        expect(out.tasks).toEqual([])
        expect(out.note).toMatch(/No earlier task matches/)
    })

    it('refuses a taskId that is not among the user\'s tasks', async () => {
        const out = await run({ taskId: '00000000-0000-4000-8000-0000000000ff' }, ctx({ idToken: 'tok' }))
        expect(out.summary).toBeUndefined()
        expect(out.note).toMatch(/not found/)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('does nothing without an idToken', async () => {
        const out = await run({ query: 'red car' }, ctx({}))
        expect(out.tasks).toEqual([])
        expect(fetchMock).not.toHaveBeenCalled()
    })
})

describe('summarizeTask', () => {
    it('trims a long task instead of returning it whole', () => {
        const long = 'x'.repeat(5000)
        const many = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: long, createdAt: String(i) }))
        const s = summarizeTask(many)
        expect(s.brief.length).toBeLessThanOrEqual(600)
        expect(s.lastReplies).toHaveLength(2)
        for (const r of s.lastReplies) expect(r.length).toBeLessThanOrEqual(400)
    })
})

describe('scoreTask', () => {
    it('weights title words over last-message words', () => {
        const byTitle = scoreTask('gym reel', { id: 'a', title: 'Gym reel', status: 'active', createdAt: '', updatedAt: '' })
        const byMessage = scoreTask('gym reel', { id: 'b', title: 'Other', status: 'active', createdAt: '', updatedAt: '', lastMessage: { content: 'gym reel', createdAt: '' } })
        expect(byTitle).toBeGreaterThan(byMessage)
    })
})
