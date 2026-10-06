import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MAX_CHECK_RECORDS, loadCheckRecords, setCheckRecordStore } from './tvcCheckRecords.js'
import { inMemoryThreadStore } from './tvcCheckRecords.testing.js'
import { markStillPassed, stillPassedCheck } from './checkStill.js'
import { droppedCheckInputs } from './checkClip.js'

vi.mock('../cost.js', () => ({ persistCost: vi.fn() }))

const mine = { threadId: 'conv-1', resourceId: 'tenant-A' }
const none = { expectedLine: false, product: false, reference: false }
const all = { expectedLine: true, product: true, reference: true }

let env: ReturnType<typeof inMemoryThreadStore>
beforeEach(() => {
  env = inMemoryThreadStore([
    { id: 'conv-1', resourceId: 'tenant-A', metadata: { workingMemory: '# Brand Context\n- Brand Name: Bubbli', skillTest: { installId: 'i1' } } },
    { id: 'conv-B', resourceId: 'tenant-B', metadata: {} },
  ])
  setCheckRecordStore(env.store)
})

describe('K1: check records live in the thread', () => {
  it('a passed still and a clip\'s check inputs survive a restart (fresh modules, same store)', async () => {
    expect(await markStillPassed(mine, 's1')).toBe(true)
    expect(await droppedCheckInputs(mine, 'clip-1', all)).toEqual([])

    vi.resetModules()
    const records = await import('./tvcCheckRecords.js')
    records.setCheckRecordStore(env.store)
    const still = await import('./checkStill.js')
    const clip = await import('./checkClip.js')
    expect(await still.stillPassedCheck(mine, 's1')).toBe(true)
    expect(await clip.droppedCheckInputs(mine, 'clip-1', none)).toEqual(['expectedLine', 'product', 'reference'])
  })

  it('keeps every other metadata key and writes only tvcChecks', async () => {
    await markStillPassed(mine, 's1')
    expect(env.updates.every((u) => Object.keys(u.metadata).join() === 'tvcChecks')).toBe(true)
    const meta = env.rows.get('conv-1')!.metadata!
    expect(meta.workingMemory).toBe('# Brand Context\n- Brand Name: Bubbli')
    expect(meta.skillTest).toEqual({ installId: 'i1' })
  })

  it('caps each list at 200, dropping the oldest first, even though jsonb sorts keys', async () => {
    for (let i = 0; i < MAX_CHECK_RECORDS + 5; i++) await markStillPassed(mine, `s${i}`)
    for (let i = 0; i < MAX_CHECK_RECORDS + 5; i++) await droppedCheckInputs(mine, `z-clip-${String(1000 - i)}`, none)
    const r = (await loadCheckRecords(mine))!
    expect(r.passedStills).toHaveLength(MAX_CHECK_RECORDS)
    expect(r.passedStills[0]).toBe('s5')
    expect(r.checkedOrder).toHaveLength(MAX_CHECK_RECORDS)
    expect(Object.keys(r.checkedWith)).toHaveLength(MAX_CHECK_RECORDS)
    expect(r.checkedWith['z-clip-1000']).toBeUndefined() // the first one written is the one dropped
    expect(r.checkedWith['z-clip-796']).toBeDefined()
  })

  it('parallel writes in one thread all land (read–merge–write under a lock)', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => markStillPassed(mine, `p${i}`)))
    expect((await loadCheckRecords(mine))!.passedStills.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `p${i}`).sort())
  })
})

// Review Focus 3.
describe('K1: never writes a foreign or missing thread', () => {
  it.each([
    ['another tenant\'s thread', { threadId: 'conv-B', resourceId: 'tenant-A' }],
    ['a missing thread', { threadId: 'nope', resourceId: 'tenant-A' }],
    ['no thread id', { threadId: '', resourceId: 'tenant-A' }],
    ['no tenant', { threadId: 'conv-1', resourceId: '' }],
  ])('%s: no write, the still is not checked, and the re-check guard falls back to process memory', async (_name, scope) => {
    expect(await markStillPassed(scope, 's1')).toBe(false)
    expect(await stillPassedCheck(scope, 's1')).toBe(false)
    expect(await droppedCheckInputs(scope, 'clip-x', all)).toEqual([])
    expect(await droppedCheckInputs(scope, 'clip-x', none)).toEqual(['expectedLine', 'product', 'reference'])
    expect(env.updates).toEqual([])
    expect(env.rows.get('conv-B')!.metadata).toEqual({})
  })

  it('a store that throws on write counts as unavailable, never as a pass', async () => {
    const broken = inMemoryThreadStore([{ id: 'conv-1', resourceId: 'tenant-A' }])
    broken.store.updateThread = async () => { throw new Error('db down') }
    setCheckRecordStore(broken.store)
    expect(await markStillPassed(mine, 's1')).toBe(false)
    expect(await stillPassedCheck(mine, 's1')).toBe(false)
  })
})
