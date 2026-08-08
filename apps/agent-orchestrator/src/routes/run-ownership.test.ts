import { describe, it, expect } from 'vitest'
import { isRunOwnedByTenant, type RunLookup } from './run-ownership.js'

/**
 * F-05 — resuming a suspended workflow must prove the run belongs to the caller.
 *
 * The bug: POST /pm/resume verified the JWT correctly, then passed the
 * body-supplied runId straight to createRun({ runId }) and resume(). Nothing
 * checked ownership. A user in tenant B holding a tenant-A runId could send
 * `approved: true` and silently approve another tenant's PRD, roadmap or task
 * generation — bypassing the human approval gate itself — or inject content via
 * `answers`/`revise`. Run IDs are not secrets: they are returned to the client
 * in every suspended-phase response and persisted into message artifactRefs.
 *
 * The guard fails closed: anything it cannot positively prove is a refusal.
 */

const WORKFLOW = 'pm-workflow'

function storeWith(runs: Record<string, { resourceId?: string | null }>): RunLookup {
  return {
    async getWorkflowRunById({ runId }) {
      return runs[runId] ?? null
    },
  }
}

describe('isRunOwnedByTenant', () => {
  it('allows a tenant to resume its own run', async () => {
    const store = storeWith({ 'run-1': { resourceId: 'tenant-a' } })
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'run-1', 'tenant-a')).resolves.toBe(true)
  })

  it('refuses a run belonging to a different tenant', async () => {
    // The attack: tenant-b resuming tenant-a's suspended approval gate.
    const store = storeWith({ 'run-1': { resourceId: 'tenant-a' } })
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'run-1', 'tenant-b')).resolves.toBe(false)
  })

  it('refuses a run that does not exist', async () => {
    const store = storeWith({})
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'nope', 'tenant-a')).resolves.toBe(false)
  })

  it('refuses a run with no recorded owner rather than assuming the caller', async () => {
    // Legacy rows predating resourceId must not become a bypass.
    const store = storeWith({ 'run-1': {} })
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'run-1', 'tenant-a')).resolves.toBe(false)
  })

  it('refuses a null owner', async () => {
    const store = storeWith({ 'run-1': { resourceId: null } })
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'run-1', 'tenant-a')).resolves.toBe(false)
  })

  it('refuses when the caller has no tenant claim', async () => {
    // An empty tenantId must never match an empty/absent resourceId.
    const store = storeWith({ 'run-1': { resourceId: '' } })
    await expect(isRunOwnedByTenant(store, WORKFLOW, 'run-1', '')).resolves.toBe(false)
  })

  it('refuses when the ownership lookup itself fails', async () => {
    const broken: RunLookup = {
      async getWorkflowRunById() {
        throw new Error('storage unavailable')
      },
    }
    // A storage outage must not open the gate.
    await expect(isRunOwnedByTenant(broken, WORKFLOW, 'run-1', 'tenant-a')).resolves.toBe(false)
  })
})
