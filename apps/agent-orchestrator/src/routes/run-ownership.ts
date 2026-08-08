/**
 * Ownership check for resuming suspended workflow runs.
 *
 * A runId is an identifier, not a credential — it is returned to the client in
 * every suspended-phase response and persisted into message artifactRefs. So a
 * resume endpoint must prove the run belongs to the caller's tenant before
 * acting on it, exactly as the rest of the platform proves ownership with
 * resolveAgent(agentId, tenantId) and loadPack(packId, tenantId).
 *
 * Runs are started with MASTRA_RESOURCE_ID_KEY set to the tenantId, which Mastra
 * persists as the run's `resourceId`. That is the recorded owner.
 *
 * Fails closed. Unknown run, missing owner, storage error — all refusals. The
 * only path returning true is a positive match, because every other outcome is
 * a case where ownership could not be proven.
 */

export interface RunLookup {
  getWorkflowRunById(args: {
    runId: string
    workflowName: string
  }): Promise<{ resourceId?: string | null } | null>
}

export async function isRunOwnedByTenant(
  store: RunLookup,
  workflowName: string,
  runId: string,
  tenantId: string,
): Promise<boolean> {
  // An absent tenant claim can never own anything; guard before the lookup so an
  // empty resourceId cannot accidentally match an empty tenantId.
  if (!tenantId) return false

  let run: { resourceId?: string | null } | null
  try {
    run = await store.getWorkflowRunById({ runId, workflowName })
  } catch (err) {
    console.error('[run-ownership] lookup failed — refusing resume', {
      runId,
      error: (err as Error).message,
    })
    return false
  }

  if (!run) return false
  if (!run.resourceId) return false

  return run.resourceId === tenantId
}
