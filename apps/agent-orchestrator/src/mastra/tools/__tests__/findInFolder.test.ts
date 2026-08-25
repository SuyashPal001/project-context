import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { listGrantedFiles, execute, embedQuery } = vi.hoisted(() => ({
    listGrantedFiles: vi.fn(),
    execute: vi.fn(),
    embedQuery: vi.fn(),
}))
vi.mock('../folderScope.js', () => ({
    listGrantedFiles,
    assertFileInGrant: vi.fn(),
    executeSql: execute,
    escapeLikePrefix: (p: string) => p,
}))
vi.mock('@serverless-saas/ai', () => ({ embedQuery }))

import { findInFolderTool } from '../findInFolder.js'

interface Matches {
    matches: Array<{ fileId: string; filename: string; contentType: string; score: number; why: string }>
    note?: string
}

async function run(input: { query: string }, execCtx: never): Promise<Matches> {
    const out = await findInFolderTool.execute!(input as never, execCtx)
    if (!out || !('matches' in out)) throw new Error(`expected matches, got ${JSON.stringify(out)}`)
    return out as Matches
}

const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
    return { requestContext } as never
}

const granted = (over: Partial<{ fileId: string; filename: string; contentType: string }> = {}) => ({
    fileId: 'f1', filename: 'contract.pdf', contentType: 'application/pdf',
    size: 1, createdAt: 'x', ...over,
})

describe('find_in_folder', () => {
    beforeEach(() => {
        listGrantedFiles.mockReset()
        execute.mockReset()
        embedQuery.mockReset().mockResolvedValue([0.1, 0.2, 0.3])
    })

    it('returns ranked files rather than prose', async () => {
        listGrantedFiles.mockResolvedValue([granted()])
        execute.mockResolvedValue([{ file_id: 'f1', score: 0.82, snippet: 'penalty clause…' }])
        const out = await run({ query: 'penalty' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.matches[0].fileId).toBe('f1')
        expect(out.matches[0].filename).toBe('contract.pdf')
        // Routing, not answering: the tool must never hand back an answer.
        expect(out).not.toHaveProperty('answer')
        expect(out.matches[0].why).toContain('penalty clause')
    })

    it('falls back to filename matching when nothing is indexed yet', async () => {
        listGrantedFiles.mockResolvedValue([
            granted({ fileId: 'f2', filename: 'budget-2026.xlsx', contentType: 'application/vnd.ms-excel' }),
        ])
        execute.mockResolvedValue([])
        const out = await run({ query: 'budget' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.matches.map(m => m.fileId)).toEqual(['f2'])
        expect(out.matches[0].why).toContain('filename')
    })

    it('ignores a ranked row for a file outside the grant', async () => {
        // The chunk query is bounded by granted ids, but a stale or mismatched
        // row must never introduce a file the grant does not cover.
        listGrantedFiles.mockResolvedValue([granted()])
        execute.mockResolvedValue([
            { file_id: 'f1', score: 0.8, snippet: 'a' },
            { file_id: 'f-elsewhere', score: 0.99, snippet: 'b' },
        ])
        const out = await run({ query: 'x' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.matches.map(m => m.fileId)).toEqual(['f1'])
    })

    it('returns nothing when no folder is granted, and embeds nothing', async () => {
        const out = await run({ query: 'x' }, ctx({ tenantId: 't1' }))
        expect(out.matches).toEqual([])
        expect(embedQuery).not.toHaveBeenCalled()
        expect(listGrantedFiles).not.toHaveBeenCalled()
    })

    it('returns nothing when the granted folder is empty, without querying chunks', async () => {
        listGrantedFiles.mockResolvedValue([])
        const out = await run({ query: 'x' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.matches).toEqual([])
        expect(execute).not.toHaveBeenCalled()
    })

    it('still routes on filenames when the chunk query fails', async () => {
        // Ranking is a nicety; losing it must not take the whole tool down.
        listGrantedFiles.mockResolvedValue([granted({ filename: 'budget.pdf' })])
        execute.mockRejectedValue(new Error('pgvector exploded'))
        const out = await run({ query: 'budget' }, ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.matches.map(m => m.fileId)).toEqual(['f1'])
        expect(out.matches[0].why).toContain('filename')
    })
})
