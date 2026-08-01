import { describe, it, expect, vi } from 'vitest'

vi.mock('@serverless-saas/database', () => ({ db: {} }))
vi.mock('../db', () => ({ db: {} }))
vi.mock('@serverless-saas/agent-schema/handover', () => ({
  handoverPacks: {}, packSections: {}, packItems: {},
}))
vi.mock('@serverless-saas/agent-schema/pm', () => ({ projectPlans: {} }))
vi.mock('@serverless-saas/database/schema/tenancy', () => ({ tenants: {} }))
vi.mock('@serverless-saas/permissions', () => ({ hasPermission: vi.fn().mockReturnValue(true) }))
vi.mock('@serverless-saas/queue', () => ({ publishToQueue: vi.fn() }))

import { toPublicProjection } from '../routes/packs.public'

const pack = {
  id: 'pack-1',
  tenantId: 'tenant-1',
  planId: 'plan-1',
  clientId: 'client-1',
  title: 'Bloom Studio Redesign',
  scopeSummary: '5-page Webflow site',
  deliveryDate: new Date('2026-05-22T00:00:00Z'),
  preparedBy: 'user-1',
  recipientName: 'Rebecca Chen',
  recipientEmail: 'rebecca@bloomstudio.co',
  status: 'sent',
  tokenHash: 'a'.repeat(64),
  signedAt: null,
  signedByName: null,
  signedByEmail: null,
}

const sections = [
  { id: 's1', packId: 'pack-1', tenantId: 'tenant-1', kind: 'delivered', title: 'Delivered items', subtitle: 'x', eyebrow: 'Y', sortOrder: 0, isVisible: true },
  { id: 's2', packId: 'pack-1', tenantId: 'tenant-1', kind: 'credentials', title: 'Credentials', subtitle: 'x', eyebrow: 'Y', sortOrder: 1, isVisible: false },
]

const items = [
  { id: 'i1', sectionId: 's1', packId: 'pack-1', tenantId: 'tenant-1', title: 'CMS collections', description: 'd', statusLabel: 'Complete', categoryLabel: 'Delivered', sourceType: 'task', sourceId: 'task-99', fileId: null, url: null, sortOrder: 0 },
  { id: 'i2', sectionId: 's2', packId: 'pack-1', tenantId: 'tenant-1', title: 'Webflow login', description: 'd', statusLabel: 'Secure', categoryLabel: 'Encrypted', sourceType: 'manual', sourceId: null, fileId: null, url: null, sortOrder: 0 },
]

describe('toPublicProjection', () => {
  const result = toPublicProjection(pack, sections, items)
  const serialized = JSON.stringify(result)

  it('never exposes the token hash', () => {
    expect(serialized).not.toContain('a'.repeat(64))
    expect(serialized).not.toContain('tokenHash')
  })

  it('never exposes tenant, plan, client, or preparer ids', () => {
    expect(serialized).not.toContain('tenant-1')
    expect(serialized).not.toContain('plan-1')
    expect(serialized).not.toContain('client-1')
    expect(serialized).not.toContain('user-1')
  })

  it('never exposes workspace provenance', () => {
    expect(serialized).not.toContain('task-99')
    expect(serialized).not.toContain('sourceId')
    expect(serialized).not.toContain('sourceType')
  })

  it('never exposes the recipient email', () => {
    expect(serialized).not.toContain('rebecca@bloomstudio.co')
  })

  it('omits hidden sections and their items', () => {
    expect(result.sections).toHaveLength(1)
    expect(result.sections[0].kind).toBe('delivered')
    expect(serialized).not.toContain('Webflow login')
  })

  it('keeps the client-facing content', () => {
    expect(result.title).toBe('Bloom Studio Redesign')
    expect(result.sections[0].items[0].title).toBe('CMS collections')
    expect(result.sections[0].items[0].statusLabel).toBe('Complete')
    expect(result.sections[0].items[0].categoryLabel).toBe('Delivered')
  })

  it('reports whether the pack has been signed', () => {
    expect(result.status).toBe('sent')
    expect(result.signedAt).toBeNull()
  })
})
