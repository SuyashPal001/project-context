import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RequestContext } from '@mastra/core/request-context'

const { assertFileInGrant, audioExec, videoExec } = vi.hoisted(() => ({
    assertFileInGrant: vi.fn(),
    audioExec: vi.fn(),
    videoExec: vi.fn(),
}))
vi.mock('../folderScope.js', () => ({ assertFileInGrant, listGrantedFiles: vi.fn() }))
vi.mock('../analyzeAudio.js', () => ({ analyzeAudioTool: { execute: audioExec } }))
vi.mock('../analyzeVideo.js', () => ({ analyzeVideoTool: { execute: videoExec } }))

import { readFileTool } from '../readFile.js'

interface ReadOut { content: string; filename: string }

async function run(input: { fileId: string }, execCtx: never): Promise<ReadOut> {
    const out = await readFileTool.execute!(input as never, execCtx)
    if (!out || !('content' in out)) throw new Error(`expected content, got ${JSON.stringify(out)}`)
    return out as ReadOut
}

const ctx = (values: Record<string, string>) => {
    const requestContext = new RequestContext()
    for (const [k, v] of Object.entries(values)) requestContext.set(k, v)
    return { requestContext } as never
}

const granted = { tenantId: 't1', folderPrefix: 'new/' }

describe('read_file', () => {
    beforeEach(() => {
        assertFileInGrant.mockReset()
        audioExec.mockReset()
        videoExec.mockReset()
    })

    it('refuses a file outside the grant before reading anything', async () => {
        assertFileInGrant.mockRejectedValue(new Error('file is outside the granted folder'))
        const out = await run({ fileId: 'f-elsewhere' }, ctx(granted))
        expect(out.content).toContain('outside the granted folder')
        expect(audioExec).not.toHaveBeenCalled()
        expect(videoExec).not.toHaveBeenCalled()
    })

    it('routes audio to analyzeAudio and returns its transcript', async () => {
        assertFileInGrant.mockResolvedValue({
            fileId: 'f1', filename: 'call.mp3', contentType: 'audio/mpeg', size: 1, createdAt: 'x',
        })
        // The real tool returns { success, transcript }, not { text }.
        audioExec.mockResolvedValue({ success: true, transcript: 'transcript' })
        const out = await run({ fileId: 'f1' }, ctx(granted))
        expect(audioExec).toHaveBeenCalled()
        expect(out.content).toBe('transcript')
        expect(out.filename).toBe('call.mp3')
    })

    it('routes video to analyzeVideo and returns its summary', async () => {
        assertFileInGrant.mockResolvedValue({
            fileId: 'f2', filename: 'clip.mp4', contentType: 'video/mp4', size: 1, createdAt: 'x',
        })
        videoExec.mockResolvedValue({ success: true, summary: 'a summary' })
        const out = await run({ fileId: 'f2' }, ctx(granted))
        expect(out.content).toBe('a summary')
    })

    it('surfaces a failed analysis instead of returning empty content', async () => {
        assertFileInGrant.mockResolvedValue({
            fileId: 'f1', filename: 'call.mp3', contentType: 'audio/mpeg', size: 1, createdAt: 'x',
        })
        audioExec.mockResolvedValue({ success: false, error: 'no_active_session' })
        const out = await run({ fileId: 'f1' }, ctx(granted))
        expect(out.content).toContain('no_active_session')
    })

    it('says a document cannot be opened and points at the tool that can', async () => {
        assertFileInGrant.mockResolvedValue({
            fileId: 'f3', filename: 'contract.pdf', contentType: 'application/pdf', size: 1, createdAt: 'x',
        })
        const out = await run({ fileId: 'f3' }, ctx(granted))
        expect(out.content).toMatch(/find_in_folder|retrieve_documents/)
        expect(out.filename).toBe('contract.pdf')
    })

    it('refuses when no folder is granted, without checking the grant', async () => {
        const out = await run({ fileId: 'f1' }, ctx({ tenantId: 't1' }))
        expect(out.content).toContain('No folder has been granted')
        expect(assertFileInGrant).not.toHaveBeenCalled()
    })
})
