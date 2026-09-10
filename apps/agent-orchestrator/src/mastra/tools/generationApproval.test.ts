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
      ['create_skill', 'edit-image', 'generate-image', 'generate-song', 'generate-video'].sort(),
    )
  })

  it('generate-image has no preview builder', () => {
    expect(GENERATION_APPROVAL_METADATA['generate-image'].buildPreview).toBeUndefined()
  })

  it('create_skill builds a preview from args.body', () => {
    const preview = GENERATION_APPROVAL_METADATA['create_skill'].buildPreview?.({ body: 'line one\nline two', name: 'x' })
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
