import { describe, it, expect } from 'vitest'
import { fileIdsIn, inputFileIdsOf, markWorkingFiles } from './workingFiles.js'

const id = (n: number) => `0000000${n}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`

describe('working files', () => {
  it('finds file ids anywhere in tool arguments, and nothing inside prose', () => {
    const ids = fileIdsIn({ videoFileId: id(1), clipFileIds: [id(2), id(3)], blocks: [{ audioFileId: id(4) }], prompt: `continue from ${id(5)}` })
    expect([...ids].sort()).toEqual([id(1), id(2), id(3), id(4)].sort())
  })
  it('marks only the files a later step used, so the final stays in front', () => {
    const atts = [1, 2, 9].map((n) => ({ fileId: id(n), name: `f${n}`, type: 'video/mp4', size: 1 }))
    const marked = markWorkingFiles(atts, fileIdsIn({ clipFileIds: [id(1), id(2)] }))
    expect(marked.map((a) => a.working ?? false)).toEqual([true, true, false])
  })
})

describe('inputFileIdsOf', () => {
  it('a file only shown to the user is not an input', () => {
    const id = '11111111-2222-3333-4444-555555555555'
    expect(inputFileIdsOf('review_shots', { shots: [{ fileId: id }] }, new Set()).size).toBe(0)
    expect(inputFileIdsOf('generate_video', { startImageFileId: id }, new Set()).has(id)).toBe(true)
  })
  it('a still a quality check looked at is not an input (Meera run: check_clip on the Scene 2 still)', () => {
    const id = 'b2afa519-a2cc-4bad-ba7c-c5d6c08c7906'
    const args = { clipFileId: id, productFileId: '0b161680-93be-4410-b287-e90e48ef8fde', referenceFileIds: ['11fff9df-63d4-4af1-bf90-25b6cb063899'], masterStillFileId: '9b3a7d1d-8143-4801-9049-e58c6f133bb4' }
    expect(inputFileIdsOf('check-clip', args, new Set()).size).toBe(0)
    expect(inputFileIdsOf('check_still', { fileId: id }, new Set()).size).toBe(0)
  })
})
