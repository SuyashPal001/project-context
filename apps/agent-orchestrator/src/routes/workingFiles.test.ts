import { describe, it, expect } from 'vitest'
import { fileIdsIn, markWorkingFiles } from './workingFiles.js'

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
