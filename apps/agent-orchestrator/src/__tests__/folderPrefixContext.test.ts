import { describe, it, expect } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'
import { resolveFolderPrefix, folderScopeLine, applyFolderScope } from '../folderScopeContext.js'

describe('resolveFolderPrefix', () => {
    it('accepts a well-formed prefix', () => {
        expect(resolveFolderPrefix({ folderPrefix: 'new/' })).toBe('new/')
    })

    it('accepts a nested prefix', () => {
        expect(resolveFolderPrefix({ folderPrefix: 'projects/2026/' })).toBe('projects/2026/')
    })

    it('omits it when no grant was made', () => {
        expect(resolveFolderPrefix({})).toBeUndefined()
        expect(resolveFolderPrefix({ folderPrefix: '' })).toBeUndefined()
        expect(resolveFolderPrefix(null)).toBeUndefined()
    })

    // The API validates a prefix when it is stored, but this value arrives on the
    // chat request body, so it is re-checked at the boundary rather than trusted
    // because something upstream is supposed to have checked it.
    it('rejects a prefix that does not end in a slash', () => {
        expect(resolveFolderPrefix({ folderPrefix: 'new' })).toBeUndefined()
    })

    it('rejects traversal and absolute paths', () => {
        expect(resolveFolderPrefix({ folderPrefix: '../other/' })).toBeUndefined()
        expect(resolveFolderPrefix({ folderPrefix: '/new/' })).toBeUndefined()
    })

    it('rejects a non-string', () => {
        expect(resolveFolderPrefix({ folderPrefix: 42 })).toBeUndefined()
        expect(resolveFolderPrefix({ folderPrefix: { prefix: 'new/' } })).toBeUndefined()
    })

    it('rejects an over-long prefix', () => {
        expect(resolveFolderPrefix({ folderPrefix: 'a'.repeat(513) + '/' })).toBeUndefined()
    })
})

describe('applyFolderScope', () => {
    it('carries a granted prefix through to the request context', () => {
        const ctx = new RequestContext()
        applyFolderScope(ctx, 'new/')
        expect(ctx.get('folderPrefix')).toBe('new/')
    })

    it('sets nothing when no grant was made', () => {
        const ctx = new RequestContext()
        applyFolderScope(ctx, undefined)
        expect(ctx.get('folderPrefix')).toBeUndefined()
    })
})

describe('folderScopeLine', () => {
    it('names the folder and points at the manifest tool', () => {
        const line = folderScopeLine('new/')
        expect(line).toContain('new/')
        expect(line).toContain('list_folder')
    })

    // A large folder must never land in the prompt — the manifest is a tool call.
    it('is empty when no folder is granted', () => {
        expect(folderScopeLine(undefined)).toBe('')
    })
})
