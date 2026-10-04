import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { uploadFileWithKey } from '../../persistence.js'
import { fetchPresignedUrl } from './mediaCache.js'
import { computeCreditPlan, priceFromRates, readBalanceForTenant } from './checkCreditPlan.js'
import { recordOnPlan, sliceTvcPlan, tvcCreditSteps, tvcPlanSchema, validateTvcPlan, type TvcPlan } from './tvcPlan.js'

// The TVC ad's plan lives in ONE file whose id never changes: it is always
// re-uploaded to the same storage key, and /files/:id/confirm keeps the
// original row (persistence.ts uploadFileWithKey). Delegations then carry only
// "TVC plan: <id>" and a step — the plan itself never rides in a prompt.
export interface SavedPlan { version: 1; storageKey: string; plan: TvcPlan }

export interface PlanTvcDeps {
  load: (planFileId: string) => Promise<SavedPlan>
  save: (doc: SavedPlan) => Promise<string | null>
  price: (plan: TvcPlan) => Promise<{ fullCostCredits: number; shortfallCredits: number }>
  newKey: () => string
}

export const planTvcInputSchema = z.object({
  action: z.enum(['check', 'get', 'record']).describe('check: validate and save the plan; get: read one slice; record: attach a finished still or clip to a shot'),
  plan: tvcPlanSchema.optional().describe('check only: the full plan'),
  planFileId: z.string().optional().describe('The TVC plan id. Required for get and record; pass it on a re-check so the plan keeps its id'),
  slice: z.string().optional().describe('get only: "brief", "finish" or "shots a-b", e.g. "shots 4-6"'),
  shot: z.number().int().min(1).optional().describe('record only: the shot number'),
  stillFileId: z.string().optional().describe('record only: the shot\'s approved still'),
  clipFileId: z.string().optional().describe('record only: the shot\'s checked, trimmed clip'),
})
export type PlanTvcInput = z.infer<typeof planTvcInputSchema>

export interface PlanTvcOutput {
  planFileId?: string
  errors?: string[]
  warnings?: string[]
  costCredits?: number
  shortfallCredits?: number
  slice?: string
  refused?: boolean
  refusalReason?: string
}

// Recorded stills and clips survive a re-check for shots whose content did not change.
function carryOver(previous: TvcPlan, next: TvcPlan): TvcPlan {
  const out = structuredClone(next)
  const strip = (s: TvcPlan['shots'][number]) => JSON.stringify({ ...s, stillFileId: undefined, clipFileId: undefined })
  out.shots.forEach((s) => {
    const before = previous.shots.find((p) => p.n === s.n)
    if (before && strip(before) === strip(s) && !s.stillFileId && !s.clipFileId) {
      if (before.stillFileId) s.stillFileId = before.stillFileId
      if (before.clipFileId) s.clipFileId = before.clipFileId
    }
  })
  return out
}

export async function runPlanTvc(input: PlanTvcInput, deps: PlanTvcDeps): Promise<PlanTvcOutput> {
  if (input.action === 'check') {
    if (!input.plan) return { refused: true, refusalReason: 'PLAN_REQUIRED' }
    const { errors, warnings, plan } = validateTvcPlan(input.plan)
    if (errors.length) return { errors, warnings }
    let storageKey = deps.newKey()
    let toSave = plan
    if (input.planFileId) {
      const previous = await deps.load(input.planFileId)
      storageKey = previous.storageKey
      toSave = carryOver(previous.plan, plan)
    }
    const planFileId = await deps.save({ version: 1, storageKey, plan: toSave })
    if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
    const cost = await deps.price(toSave)
    return { planFileId, errors: [], warnings, costCredits: cost.fullCostCredits, shortfallCredits: cost.shortfallCredits }
  }
  if (!input.planFileId) return { refused: true, refusalReason: 'PLAN_FILE_ID_REQUIRED' }
  const doc = await deps.load(input.planFileId)
  if (input.action === 'get') {
    try {
      return { planFileId: input.planFileId, slice: JSON.stringify(sliceTvcPlan(doc.plan, input.slice ?? '')) }
    } catch {
      return { refused: true, refusalReason: 'UNKNOWN_SLICE' }
    }
  }
  if (!input.shot || (!input.stillFileId && !input.clipFileId)) return { refused: true, refusalReason: 'SHOT_AND_FILE_REQUIRED' }
  let next: TvcPlan
  try {
    next = recordOnPlan(doc.plan, input.shot, { stillFileId: input.stillFileId, clipFileId: input.clipFileId })
  } catch {
    return { refused: true, refusalReason: 'NO_SUCH_SHOT' }
  }
  const planFileId = await deps.save({ ...doc, plan: next })
  if (!planFileId) return { refused: true, refusalReason: 'STORAGE_FAILED' }
  return { planFileId }
}

export const planTvc = createTool({
  id: 'plan-tvc',
  description: 'Free. The TVC ad plan: "check" validates the plan against the TVC craft rules and saves it (returns the plan id and cost, or plain errors to fix); "get" returns only the slice one step needs; "record" attaches a finished still or clip to its shot. Use only in the TVC ad flow.',
  inputSchema: planTvcInputSchema,
  outputSchema: z.object({
    planFileId: z.string().optional(),
    errors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    costCredits: z.number().optional(),
    shortfallCredits: z.number().optional(),
    slice: z.string().optional(),
    refused: z.boolean().optional(),
    refusalReason: z.string().optional(),
  }),
  execute: async (inputData, execContext) => {
    const idToken = execContext?.requestContext?.get('idToken') as string | undefined
    const conversationId = execContext?.requestContext?.get('conversationId') as string | undefined
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    if (!idToken || !conversationId) return { refused: true, refusalReason: 'NO_SESSION_CONTEXT' }
    const deps: PlanTvcDeps = {
      load: async (planFileId) => {
        const url = new URL(await fetchPresignedUrl(planFileId, idToken))
        url.searchParams.delete('x-amz-checksum-mode')
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`plan ${planFileId}: ${res.status}`)
        return await res.json() as SavedPlan
      },
      save: async (doc) => (await uploadFileWithKey(idToken, {
        key: doc.storageKey, name: 'TVC plan.json', content: JSON.stringify(doc), contentType: 'application/json',
      }))?.fileId ?? null,
      price: async (plan) => {
        const result = await computeCreditPlan(tvcCreditSteps(plan), { priceMicro: priceFromRates, readBalance: () => readBalanceForTenant(tenantId) })
        return { fullCostCredits: result.fullCostCredits, shortfallCredits: result.shortfallCredits }
      },
      newKey: () => `generated/${conversationId}/tvc-plan-${randomUUID()}.json`,
    }
    try {
      return await runPlanTvc(inputData as PlanTvcInput, deps)
    } catch (err) {
      console.error('[planTvc] failed:', (err as Error).message)
      return { refused: true, refusalReason: 'PLAN_UNAVAILABLE' }
    }
  },
})
