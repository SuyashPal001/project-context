import { describe, it, expect } from 'vitest'
import { buildTaskRevisions, TRACKED_FIELDS } from '../lib/revisions'

const meta = {
  taskId: '11111111-1111-1111-1111-111111111111',
  tenantId: '22222222-2222-2222-2222-222222222222',
  actorType: 'human' as const,
  actorId: '33333333-3333-3333-3333-333333333333',
}

const before = {
  title: 'Add auth',
  description: 'Draft written by the analyst agent.',
  acceptanceCriteria: [{ text: 'login works', checked: false }],
  estimatedHours: '4.00',
  status: 'todo',
}

describe('buildTaskRevisions', () => {
  it('returns no revisions when the patch is empty', () => {
    expect(buildTaskRevisions(before, {}, meta)).toEqual([])
  })

  it('returns no revision when a tracked field is unchanged', () => {
    expect(buildTaskRevisions(before, { title: 'Add auth' }, meta)).toEqual([])
  })

  it('records a revision when a tracked field changes', () => {
    const result = buildTaskRevisions(before, { title: 'Add SSO auth' }, meta)
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      taskId: meta.taskId,
      tenantId: meta.tenantId,
      field: 'title',
      originalContent: 'Add auth',
      correctedContent: 'Add SSO auth',
      wasEdited: true,
      actorType: 'human',
      actorId: meta.actorId,
    })
  })

  it('ignores fields that are not tracked', () => {
    expect(buildTaskRevisions(before, { status: 'done' }, meta)).toEqual([])
  })

  it('records one revision per changed tracked field, in TRACKED_FIELDS order', () => {
    const result = buildTaskRevisions(
      before,
      { description: 'Rewritten by a human.', title: 'Add SSO auth' },
      meta,
    )
    expect(result.map((r) => r.field)).toEqual(['title', 'description'])
  })

  it('deep-compares structured fields rather than comparing references', () => {
    const unchanged = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ text: 'login works', checked: false }] },
      meta,
    )
    expect(unchanged).toEqual([])

    const changed = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ text: 'login works', checked: true }] },
      meta,
    )
    expect(changed).toHaveLength(1)
    expect(changed[0].field).toBe('acceptanceCriteria')
  })

  it('ignores object key order, which jsonb does not preserve', () => {
    const result = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ checked: false, text: 'login works' }] },
      meta,
    )
    expect(result).toEqual([])
  })

  it('still detects a real change when keys are reordered', () => {
    const result = buildTaskRevisions(
      before,
      { acceptanceCriteria: [{ checked: true, text: 'login works' }] },
      meta,
    )
    expect(result).toHaveLength(1)
    expect(result[0].field).toBe('acceptanceCriteria')
  })

  it('records a null correction as a real change', () => {
    const result = buildTaskRevisions(before, { description: null }, meta)
    expect(result).toHaveLength(1)
    expect(result[0].correctedContent).toBeNull()
  })

  it('marks agent-authored changes as not edited', () => {
    const result = buildTaskRevisions(
      before,
      { title: 'Add SSO auth' },
      { ...meta, actorType: 'agent' },
    )
    expect(result[0].wasEdited).toBe(false)
    expect(result[0].actorType).toBe('agent')
  })

  it('tracks exactly the intent-carrying fields', () => {
    expect(TRACKED_FIELDS).toEqual([
      'title',
      'description',
      'acceptanceCriteria',
      'estimatedHours',
    ])
  })
})
