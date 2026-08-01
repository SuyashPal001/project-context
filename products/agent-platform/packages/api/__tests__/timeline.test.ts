import { describe, it, expect } from 'vitest'
import { mergeTimeline, compareTimelineRows } from '../lib/timeline'

const rev = (id: string, at: string, field = 'title') => ({
  id,
  field: field as 'title' | 'description' | 'acceptanceCriteria' | 'estimatedHours',
  originalContent: 'before',
  correctedContent: 'after',
  actorType: 'human' as const,
  actorName: 'Priya',
  createdAt: at,
})

const evt = (id: string, at: string, eventType = 'plan_approved') => ({
  id,
  eventType,
  actorType: 'human' as const,
  actorName: 'Priya',
  payload: {},
  createdAt: at,
})

describe('mergeTimeline', () => {
  it('returns an empty feed when there is nothing to show', () => {
    expect(mergeTimeline({ rawInput: null, revisions: [], events: [] })).toEqual([])
  })

  it('emits an origin row when rawInput is present', () => {
    const rows = mergeTimeline({ rawInput: 'log in with Google', revisions: [], events: [] })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'origin', content: 'log in with Google' })
  })

  it('emits no origin row for a legacy task with no rawInput', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', '2026-08-01T10:00:00Z')],
      events: [],
    })
    expect(rows.every((r) => r.kind !== 'origin')).toBe(true)
  })

  it('sorts ascending by timestamp', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r2', '2026-08-01T12:00:00Z')],
      events: [evt('e1', '2026-08-01T10:00:00Z')],
    })
    expect(rows.map((r) => 'id' in r && r.id)).toEqual(['e1', 'r2'])
  })

  it('pins origin first even when its timestamp is later than every other row', () => {
    const rows = mergeTimeline({
      rawInput: 'the original ask',
      originAt: '2026-08-01T23:00:00Z',
      revisions: [rev('r1', '2026-08-01T10:00:00Z')],
      events: [evt('e1', '2026-08-01T09:00:00Z')],
    })
    expect(rows[0].kind).toBe('origin')
    expect(rows.map((r) => 'id' in r && r.id)).toEqual([false, 'e1', 'r1'])
  })

  it('breaks timestamp ties as event before revision', () => {
    const at = '2026-08-01T10:00:00Z'
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', at)],
      events: [evt('e1', at)],
    })
    expect(rows.map((r) => 'id' in r && r.id)).toEqual(['e1', 'r1'])
  })

  it('breaks ties within the same kind by id, so the order is stable across renders', () => {
    const at = '2026-08-01T10:00:00Z'
    const forward = mergeTimeline({
      rawInput: null,
      revisions: [rev('r-b', at), rev('r-a', at)],
      events: [],
    })
    const reversed = mergeTimeline({
      rawInput: null,
      revisions: [rev('r-a', at), rev('r-b', at)],
      events: [],
    })
    expect(forward.map((r) => 'id' in r && r.id)).toEqual(['r-a', 'r-b'])
    expect(reversed.map((r) => 'id' in r && r.id)).toEqual(['r-a', 'r-b'])
  })

  it('carries revision fields through to the row', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [rev('r1', '2026-08-01T10:00:00Z', 'estimatedHours')],
      events: [],
    })
    expect(rows[0]).toMatchObject({
      kind: 'revision',
      field: 'estimatedHours',
      originalContent: 'before',
      correctedContent: 'after',
      actorType: 'human',
      actorName: 'Priya',
    })
  })

  it('passes an unknown event type through rather than throwing', () => {
    const rows = mergeTimeline({
      rawInput: null,
      revisions: [],
      events: [evt('e1', '2026-08-01T10:00:00Z', 'something_new')],
    })
    expect(rows[0]).toMatchObject({ kind: 'event', eventType: 'something_new' })
  })

  it('does not mutate its input arrays', () => {
    const revisions = [rev('r2', '2026-08-01T12:00:00Z'), rev('r1', '2026-08-01T10:00:00Z')]
    const events = [evt('e1', '2026-08-01T11:00:00Z')]
    mergeTimeline({ rawInput: null, revisions, events })
    expect(revisions.map((r) => r.id)).toEqual(['r2', 'r1'])
    expect(events.map((e) => e.id)).toEqual(['e1'])
  })

  it('is a valid total order when compared rows are both origin', () => {
    const rows = mergeTimeline({
      rawInput: 'the ask',
      originAt: '2026-08-01T10:00:00Z',
      revisions: [],
      events: [],
    })
    // One origin row is all mergeTimeline can produce, so exercise the
    // comparator directly against the degenerate pair it must survive.
    expect(rows).toHaveLength(1)
    const origin = rows[0]
    expect(compareTimelineRows(origin, origin)).toBe(0)
  })
})
