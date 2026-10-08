import { describe, it, expect, vi } from 'vitest'

vi.mock('../../tools/folderScope.js', () => ({ executeSql: vi.fn() }))

import { referencedFiles, missingReferenceReason } from '../referenceCheck.js'

const AVATAR = 'f16cb519-31f8-4e7c-ab01-71afe3457d3d'
const PRODUCT = '0b161680-93be-4410-b287-e90e48ef8fde'
const FAKE_VIDEO = '6fb4f21d-72fb-4c6e-a342-9908de7517c2'

// The prompt Olmo sent on 2026-10-08, trimmed.
const PROMPT = [
  'flow: animation character ad',
  'build: board',
  `avatar reference: ${AVATAR}`,
  `product reference: ${PRODUCT}`,
  `joined video reference: ${FAKE_VIDEO}`,
  `narration line 1 reference: ${PRODUCT}`,
  'voiceId: en-in-commercial-3',
  '',
  `Fix ONLY the Storyboard Sheet image (868c7c09-2b8c-4182-98e5-79aa138fe265) using edit_image`,
].join('\n')

describe('referencedFiles', () => {
  it('reads the "<what> reference: <id>" lines once per id, and nothing else', () => {
    expect(referencedFiles(PROMPT)).toEqual([
      { label: 'avatar reference', fileId: AVATAR },
      { label: 'product reference', fileId: PRODUCT },
      { label: 'joined video reference', fileId: FAKE_VIDEO },
    ])
    expect(referencedFiles(`Reference video: \`${FAKE_VIDEO}\``)).toEqual([{ label: 'Reference video', fileId: FAKE_VIDEO }])
    expect(referencedFiles('make an image of a cat')).toEqual([])
  })
})

describe('missingReferenceReason', () => {
  it('refuses a delegation that names a file never made', async () => {
    const lookup = vi.fn().mockResolvedValue(new Set([AVATAR, PRODUCT]))
    const reason = await missingReferenceReason('t1', PROMPT, lookup)
    expect(lookup).toHaveBeenCalledWith('t1', [AVATAR, PRODUCT, FAKE_VIDEO])
    expect(reason).toContain(`"joined video reference" (${FAKE_VIDEO})`)
    expect(reason).toContain('Not delegated')
  })

  it('lets it run when every reference is real, when there are none, or when the lookup fails', async () => {
    expect(await missingReferenceReason('t1', PROMPT, vi.fn().mockResolvedValue(new Set([AVATAR, PRODUCT, FAKE_VIDEO])))).toBeNull()
    const lookup = vi.fn()
    expect(await missingReferenceReason('t1', 'make an image', lookup)).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
    expect(await missingReferenceReason('t1', PROMPT, vi.fn().mockRejectedValue(new Error('db down')))).toBeNull()
  })
})
