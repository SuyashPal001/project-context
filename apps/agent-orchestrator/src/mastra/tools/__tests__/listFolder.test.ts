import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { listGrantedFiles } = vi.hoisted(() => ({ listGrantedFiles: vi.fn() }))
vi.mock('../folderScope.js', () => ({ listGrantedFiles, assertFileInGrant: vi.fn() }))

import { listFolderTool } from '../listFolder.js'

interface Manifest {
    files: Array<{ fileId: string; filename: string; contentType: string; size: number }>
    note?: string
}

// Mastra types execute's return as the tool's output union'd with a validation
// error. Guarding rather than casting means a regression that starts returning
// a validation error fails the test instead of being silently narrowed away.
async function run(execCtx: never): Promise<Manifest> {
    const out = await listFolderTool.execute!({} as never, execCtx)
    if (!out || !('files' in out)) throw new Error(`expected a manifest, got ${JSON.stringify(out)}`)
    return out as Manifest
}

const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
    return { requestContext } as never
}

describe('list_folder', () => {
    beforeEach(() => listGrantedFiles.mockReset())

    it('returns the manifest for the granted folder', async () => {
        listGrantedFiles.mockResolvedValue([
            { fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10, createdAt: 'x' },
        ])
        const out = await run(ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.files).toEqual([
            { fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10 },
        ])
    })

    // Names, types and sizes only — the point of the manifest is that contents
    // stay unread until the agent asks for a specific file.
    it('never returns file contents or timestamps', async () => {
        listGrantedFiles.mockResolvedValue([
            { fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf', size: 10, createdAt: 'x' },
        ])
        const out = await run(ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(Object.keys(out.files[0]).sort()).toEqual(['contentType', 'fileId', 'filename', 'size'])
    })

    it('says so plainly when no folder is granted, and queries nothing', async () => {
        const out = await run(ctx({ tenantId: 't1' }))
        expect(out.files).toEqual([])
        expect(out.note).toMatch(/no folder/i)
        expect(listGrantedFiles).not.toHaveBeenCalled()
    })

    it('queries nothing when the tenant is missing', async () => {
        const out = await run(ctx({ folderPrefix: 'new/' }))
        expect(out.files).toEqual([])
        expect(listGrantedFiles).not.toHaveBeenCalled()
    })

    it('reports an empty granted folder as empty rather than ungranted', async () => {
        listGrantedFiles.mockResolvedValue([])
        const out = await run(ctx({ tenantId: 't1', folderPrefix: 'new/' }))
        expect(out.files).toEqual([])
        expect(out.note).toMatch(/empty/i)
    })
})
