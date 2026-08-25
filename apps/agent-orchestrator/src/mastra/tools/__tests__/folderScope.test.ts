import { describe, it, expect, vi, beforeEach } from 'vitest'

// The orchestrator imports the client from the package root — '@serverless-saas/database',
// not '/client'. A mock on a specifier the module does not import applies to
// nothing and the test would open a real connection.
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@serverless-saas/database', () => ({ db: { execute } }))

import { listGrantedFiles, assertFileInGrant, escapeLikePrefix } from '../folderScope.js'

describe('escapeLikePrefix', () => {
    // The API rejects traversal but not LIKE metacharacters. Without escaping,
    // a grant of "a%/" expands to `key LIKE 'a%/%'` and reaches every folder
    // starting with "a" — the model never has to do anything clever, the grant
    // itself is already too wide.
    it('escapes % so a prefix cannot widen its own grant', () => {
        expect(escapeLikePrefix('a%/')).toBe('a\\%/')
    })

    it('escapes _ , which matches any single character', () => {
        expect(escapeLikePrefix('new_/')).toBe('new\\_/')
    })

    it('escapes backslash first so escaping cannot be escaped', () => {
        expect(escapeLikePrefix('a\\%/')).toBe('a\\\\\\%/')
    })

    it('leaves an ordinary prefix untouched', () => {
        expect(escapeLikePrefix('new/')).toBe('new/')
    })
})

describe('listGrantedFiles', () => {
    beforeEach(() => execute.mockReset())

    it('maps the row shape the files table actually has', async () => {
        // Columns are name and mime_type, not filename and content_type.
        execute.mockResolvedValue([{
            file_id: 'f1', name: 'a.pdf', mime_type: 'application/pdf',
            size: 10, created_at: '2026-08-01',
        }])
        expect(await listGrantedFiles('t1', 'new/')).toEqual([{
            fileId: 'f1', filename: 'a.pdf', contentType: 'application/pdf',
            size: 10, createdAt: '2026-08-01',
        }])
    })

    it('accepts the { rows } result shape as well as a bare array', async () => {
        execute.mockResolvedValue({ rows: [{
            file_id: 'f1', name: 'a.pdf', mime_type: 'application/pdf', size: 1, created_at: 'x',
        }] })
        expect((await listGrantedFiles('t1', 'new/'))[0].fileId).toBe('f1')
    })

    it('survives a null size and mime type, which the schema permits', async () => {
        execute.mockResolvedValue([{ file_id: 'f1', name: 'a', mime_type: null, size: null, created_at: 'x' }])
        const [f] = await listGrantedFiles('t1', 'new/')
        expect(f.size).toBe(0)
        expect(f.contentType).toBe('application/octet-stream')
    })

    it('returns nothing when the grant matches no files', async () => {
        execute.mockResolvedValue([])
        expect(await listGrantedFiles('t1', 'empty/')).toEqual([])
    })
})

describe('assertFileInGrant', () => {
    beforeEach(() => execute.mockReset())

    it('returns the file when it is inside the grant', async () => {
        execute.mockResolvedValue([{
            file_id: 'f1', name: 'a.pdf', mime_type: 'application/pdf', size: 2, created_at: 'x',
        }])
        expect((await assertFileInGrant('t1', 'new/', 'f1')).filename).toBe('a.pdf')
    })

    it('refuses a fileId that is not under the prefix', async () => {
        execute.mockResolvedValue([])
        await expect(assertFileInGrant('t1', 'new/', 'f-elsewhere'))
            .rejects.toThrow('file is outside the granted folder')
    })

    it('refuses a fileId belonging to another tenant', async () => {
        execute.mockResolvedValue([])
        await expect(assertFileInGrant('t1', 'new/', 'f-other-tenant'))
            .rejects.toThrow('file is outside the granted folder')
    })

    it('refuses when no prefix is granted, without querying', async () => {
        await expect(assertFileInGrant('t1', '', 'f1'))
            .rejects.toThrow('file is outside the granted folder')
        expect(execute).not.toHaveBeenCalled()
    })
})
