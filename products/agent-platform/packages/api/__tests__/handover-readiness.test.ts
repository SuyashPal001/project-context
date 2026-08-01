import { describe, it, expect } from 'vitest'
import { computeReadiness } from '../lib/handover-readiness'

const fullPack = {
  scopeSummary: '5-page Webflow site with CMS blog',
  deliveryDate: new Date('2026-05-22T00:00:00Z'),
  recipientEmail: 'rebecca@bloomstudio.co',
}

const sections = [
  { id: 's1', title: 'Delivered items', isVisible: true },
  { id: 's2', title: 'Credentials', isVisible: false },
  { id: 's3', title: 'Training materials', isVisible: true },
]

const items = [
  { sectionId: 's1' },
  { sectionId: 's3' },
]

describe('computeReadiness', () => {
  it('reports complete when every check passes', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.complete).toBe(r.total)
    expect(r.pct).toBe(100)
    expect(r.checks.every((c) => c.complete)).toBe(true)
  })

  it('produces one check per visible section plus the three pack fields', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.total).toBe(5)
  })

  it('ignores hidden sections entirely', () => {
    const r = computeReadiness(fullPack, sections, items)
    expect(r.checks.map((c) => c.key)).not.toContain('section:s2')
  })

  it('fails the scope check when scopeSummary is blank', () => {
    const r = computeReadiness({ ...fullPack, scopeSummary: '   ' }, sections, items)
    expect(r.checks.find((c) => c.key === 'scopeSummary')!.complete).toBe(false)
    expect(r.complete).toBe(4)
  })

  it('fails the delivery date check when it is null', () => {
    const r = computeReadiness({ ...fullPack, deliveryDate: null }, sections, items)
    expect(r.checks.find((c) => c.key === 'deliveryDate')!.complete).toBe(false)
  })

  it('fails the recipient check when the email is missing', () => {
    const r = computeReadiness({ ...fullPack, recipientEmail: null }, sections, items)
    expect(r.checks.find((c) => c.key === 'recipientEmail')!.complete).toBe(false)
  })

  it('fails a section check when that section has no items', () => {
    const r = computeReadiness(fullPack, sections, [{ sectionId: 's1' }])
    expect(r.checks.find((c) => c.key === 'section:s3')!.complete).toBe(false)
    expect(r.complete).toBe(4)
  })

  it('rounds the percentage to a whole number', () => {
    const r = computeReadiness({ scopeSummary: null, deliveryDate: null, recipientEmail: null }, sections, items)
    expect(r.pct).toBe(40)
    expect(Number.isInteger(r.pct)).toBe(true)
  })

  it('reports 0 percent rather than NaN when there is nothing to check', () => {
    const r = computeReadiness({ scopeSummary: null, deliveryDate: null, recipientEmail: null }, [], [])
    expect(r.pct).toBe(0)
  })

  it('labels every check with human-readable text', () => {
    for (const check of computeReadiness(fullPack, sections, items).checks) {
      expect(check.label.length).toBeGreaterThan(0)
    }
  })
})
