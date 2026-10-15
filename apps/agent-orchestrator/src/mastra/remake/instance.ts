// The remake workflow runs on its OWN Mastra instance: same Postgres store (so runs
// survive restarts), but never registered on the instance mounted at /studio, whose
// API has no user auth (review I5). Only the remake_video tool reaches it.
import { Mastra } from '@mastra/core'
import type { MastraCompositeStore } from '@mastra/core/storage'
import { videoRemakeWorkflow } from './workflow.js'

let instance: Mastra | null = null
let testStorage: MastraCompositeStore | null = null

export function setRemakeStorageForTests(storage: MastraCompositeStore | null): void {
  testStorage = storage
  instance = null
}

export const REMAKE_WORKFLOW_ID = 'video-remake'

/** The private instance. Callers do `(await remakeMastra()).getWorkflow(REMAKE_WORKFLOW_ID)`:
 *  a Workflow has a builder `.then()`, so returning one from an async function makes
 *  `await` treat it as a thenable and hang forever. */
export async function remakeMastra(): Promise<Mastra> {
  if (!instance) {
    const storage = testStorage ?? (await import('../memory.js')).getMastraStore()
    instance = new Mastra({ workflows: { [REMAKE_WORKFLOW_ID]: videoRemakeWorkflow }, storage, logger: false })
  }
  return instance
}
