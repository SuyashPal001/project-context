import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

// vi.hoisted because vi.mock is lifted above the imports — a plain top-level
// const is not initialised by the time the factory runs. The specifier is the
// package root, not '@serverless-saas/ai/retrieve': a mock on a path the tool
// does not import silently does not apply, and the test would hit the real
// database client instead.
const { retrieveChunks } = vi.hoisted(() => ({ retrieveChunks: vi.fn() }))
vi.mock('@serverless-saas/ai', () => ({ retrieveChunks }))

import { retrieveDocumentsTool } from '../retrieveDocuments.js'

// A real RequestContext, not a `{ get }` stub: this tool declares a
// requestContextSchema, and Mastra validates the context object itself — a stub
// serialises as {} and the tool rejects the call before reaching retrieveChunks.
const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
    return { requestContext } as never
}

describe('retrieveDocumentsTool scope', () => {
    beforeEach(() => {
        retrieveChunks.mockClear()
        retrieveChunks.mockResolvedValue([])
    })

    it('ignores a folderId supplied by the model', async () => {
        await retrieveDocumentsTool.execute!(
            { query: 'q', folderId: 'attacker-chosen-folder' } as never,
            ctx({ tenantId: 't1', folderId: 'granted-folder' }),
        )
        // 5th positional arg is the scope passed through to the SQL filter.
        expect(retrieveChunks.mock.calls[0]?.[4]).toBe('granted-folder')
    })

    it('uses no scope when the context grants none, even if the model supplies one', async () => {
        await retrieveDocumentsTool.execute!(
            { query: 'q', folderId: 'attacker-chosen-folder' } as never,
            ctx({ tenantId: 't1' }),
        )
        expect(retrieveChunks).toHaveBeenCalled()
        expect(retrieveChunks.mock.calls[0]?.[4]).toBeUndefined()
    })
})
