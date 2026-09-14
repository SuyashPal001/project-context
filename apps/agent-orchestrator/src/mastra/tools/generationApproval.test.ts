import { describe, it, expect, vi, beforeEach } from 'vitest'

const { isUnlimited, resolveRate } = vi.hoisted(() => ({
  isUnlimited: vi.fn(),
  resolveRate: vi.fn(),
}))
vi.mock('@serverless-saas/credits', () => ({ isUnlimited, resolveRate }))

import { shouldRequireApproval, GENERATION_APPROVAL_METADATA, buildSkillPreview, detectSkillPii } from './generationApproval.js'

const baseCtx = (extra: Record<string, unknown> = {}) => ({
  requestContext: { tenantId: 't1', sessionId: 's1', userId: 'u1', sendEvent: vi.fn(), ...extra },
})

beforeEach(() => {
  vi.resetAllMocks()
  isUnlimited.mockResolvedValue(false)
  resolveRate.mockResolvedValue({ id: 'rate1', version: 1, schema: { per_call_micro: 50_000 } })
})

describe('shouldRequireApproval', () => {
  it('requires approval by default (priced, limited tenant, no allowMode)', async () => {
    const result = await shouldRequireApproval({ resourceType: 'image_generation', subject: 'model-x' }, baseCtx())
    expect(result).toBe(true)
  })

  it('skips approval for an unlimited tenant', async () => {
    isUnlimited.mockResolvedValue(true)
    const result = await shouldRequireApproval({ resourceType: 'image_generation', subject: 'model-x' }, baseCtx())
    expect(result).toBe(false)
  })

  it('skips approval when allowMode is auto', async () => {
    const result = await shouldRequireApproval(
      { resourceType: 'image_generation', subject: 'model-x' },
      baseCtx({ allowMode: 'auto' }),
    )
    expect(result).toBe(false)
  })

  it('skips approval when no active rate resolves', async () => {
    resolveRate.mockResolvedValue(null)
    const result = await shouldRequireApproval({ resourceType: 'image_generation', subject: 'model-x' }, baseCtx())
    expect(result).toBe(false)
  })

  it('skips approval outside a live session (no sendEvent/sessionId/tenantId/userId)', async () => {
    const result = await shouldRequireApproval(
      { resourceType: 'image_generation', subject: 'model-x' },
      { requestContext: {} },
    )
    expect(result).toBe(false)
    expect(isUnlimited).not.toHaveBeenCalled()
  })
})

describe('GENERATION_APPROVAL_METADATA', () => {
  it('has an entry for every gated tool id', () => {
    expect(Object.keys(GENERATION_APPROVAL_METADATA).sort()).toEqual(
      [
        'edit-image', 'edit_image',
        'generate-image', 'generate_image',
        'generate-song', 'generate_song',
        'generate-video', 'generate_video',
        'save_skill',
      ].sort(),
    )
  })

  // directorAgent/producerAgent register generation tools under underscored
  // keys ('generate_image') even though the tool `id` is hyphenated
  // ('generate-image'), because the KEY is what the model calls the tool.
  // The `tool-call-approval` chunk that bubbles up from a delegate carries the
  // delegate's key, not the tool id — so without both forms mapped here,
  // chatStream.ts's approval branch falls into its "unmapped tool" fallback
  // and its resumeStream() crashes with "not suspended" because Olmo itself
  // never suspended.
  it('maps the underscored delegate keys to the same metadata as the hyphenated tool ids', () => {
    expect(GENERATION_APPROVAL_METADATA['generate_image']).toBe(GENERATION_APPROVAL_METADATA['generate-image'])
    expect(GENERATION_APPROVAL_METADATA['edit_image']).toBe(GENERATION_APPROVAL_METADATA['edit-image'])
    expect(GENERATION_APPROVAL_METADATA['generate_video']).toBe(GENERATION_APPROVAL_METADATA['generate-video'])
    expect(GENERATION_APPROVAL_METADATA['generate_song']).toBe(GENERATION_APPROVAL_METADATA['generate-song'])
  })

  it('generate-image has no preview builder', () => {
    expect(GENERATION_APPROVAL_METADATA['generate-image'].buildPreview).toBeUndefined()
  })

  it('save_skill builds a preview from args.body', () => {
    const preview = GENERATION_APPROVAL_METADATA['save_skill'].buildPreview?.({ body: 'line one\nline two', name: 'x' })
    expect(preview).toContain('line one')
  })
})

describe('buildSkillPreview', () => {
  it('truncates to 16 lines / 800 chars with an ellipsis', () => {
    const body = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const preview = buildSkillPreview(body)
    expect(preview.split('\n').length).toBeLessThanOrEqual(17) // 16 lines + trailing "…"
    expect(preview.endsWith('…')).toBe(true)
  })

  it('returns the body unchanged when it fits', () => {
    expect(buildSkillPreview('short')).toBe('short')
  })
})

describe('detectSkillPii', () => {
  it('returns empty string when no PII detected', () => {
    expect(detectSkillPii('just some instructions')).toBe('')
  })

  it('names detected types when PII is present', () => {
    const note = detectSkillPii('contact me at a@b.com')
    expect(note).toContain('personal data detected')
  })
})
