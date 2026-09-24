import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { costMicro, resolveRate } from '@serverless-saas/credits'
import { BALANCE_QUERY } from '../../credits.js'
import { getPool } from '../../usage.js'
import { tenantContextSchema } from '../context.js'

const MICRO_PER_CREDIT = 1_000_000

export type StepKind = 'image' | 'video' | 'narration' | 'music' | 'lipsync' | 'lipsync_hq' | 'edit'

// Same job types and subjects the generation tools charge against, so the
// estimate reads the same rate rows the real debit will. 'edit' prices as one
// ffmpeg assembly call — the deterministic edit tools all sit in the same
// clip_assembly family at flat per-call rates.
const PRICING: Record<StepKind, { jobType: string; subject: string }> = {
  image: { jobType: 'image_generation', subject: 'gemini-3-pro-image-preview' },
  video: { jobType: 'video_generation', subject: 'google/gemini-omni-1.1-flash' },
  narration: { jobType: 'narration_generation', subject: 'sonic-3.5' },
  music: { jobType: 'music_generation', subject: 'lyria-002' },
  lipsync: { jobType: 'lipsync_generation', subject: 'fal-ai/latentsync' },
  lipsync_hq: { jobType: 'lipsync_generation', subject: 'sync-2.0' },
  edit: { jobType: 'clip_assembly', subject: 'ffmpeg-local' },
}

export interface PlanStep { kind: StepKind; count: number }

export interface BalanceRead { unlimited: boolean; balanceMicro: bigint }

export interface CreditPlanDeps {
  priceMicro: (kind: StepKind) => Promise<bigint | null>
  readBalance: () => Promise<BalanceRead>
}

export interface CreditPlanOption {
  label: string
  description: string
  costCredits: number
}

export interface CreditPlanResult {
  fullCostCredits: number
  balanceCredits: number | null
  shortfallCredits: number
  unlimited: boolean
  balanceUnknown: boolean
  unpricedKinds: StepKind[]
  options: CreditPlanOption[]
}

const toCredits = (micro: bigint): number => Number(micro) / MICRO_PER_CREDIT

function mergeSteps(steps: PlanStep[]): PlanStep[] {
  const byKind = new Map<StepKind, number>()
  for (const s of steps) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + s.count)
  return [...byKind.entries()].map(([kind, count]) => ({ kind, count }))
}

const isGeneratedVisual = (kind: StepKind) => kind === 'video' || kind === 'image'

export async function computeCreditPlan(steps: PlanStep[], deps: CreditPlanDeps): Promise<CreditPlanResult> {
  const merged = mergeSteps(steps)
  const unit = new Map<StepKind, bigint>()
  const unpriced: StepKind[] = []
  for (const { kind } of merged) {
    const price = await deps.priceMicro(kind)
    if (price === null) unpriced.push(kind)
    else unit.set(kind, price)
  }
  const cost = (plan: PlanStep[]): bigint =>
    plan.reduce((sum, s) => sum + (unit.get(s.kind) ?? 0n) * BigInt(s.count), 0n)
  const full = cost(merged)

  let balance: BalanceRead | null = null
  try {
    balance = await deps.readBalance()
  } catch (err) {
    console.error('[checkCreditPlan] balance read failed:', (err as Error).message)
  }

  const base = { fullCostCredits: toCredits(full), unpricedKinds: unpriced }
  if (!balance) {
    return { ...base, balanceCredits: null, shortfallCredits: 0, unlimited: false, balanceUnknown: true, options: [] }
  }
  if (balance.unlimited) {
    return { ...base, balanceCredits: null, shortfallCredits: 0, unlimited: true, balanceUnknown: false, options: [] }
  }

  const available = balance.balanceMicro
  const shortfall = full > available ? full - available : 0n
  const result: CreditPlanResult = {
    ...base,
    balanceCredits: toCredits(available),
    shortfallCredits: toCredits(shortfall),
    unlimited: false,
    balanceUnknown: false,
    options: [],
  }
  if (shortfall === 0n) return result

  const seen = new Set<bigint>([full])
  const consider = (label: string, description: string, plan: PlanStep[]) => {
    const c = cost(plan)
    if (c > available || seen.has(c)) return
    seen.add(c)
    result.options.push({ label, description, costCredits: toCredits(c) })
  }

  consider(
    'Hero clip only',
    'Generate just the single highest-impact clip at full quality and skip the rest; cheap and immediately postable.',
    merged.map((s) => (isGeneratedVisual(s.kind) ? { ...s, count: 1 } : s)),
  )
  consider(
    'Fewer clips',
    'Keep the same structure but generate about half as many clips and images.',
    merged.map((s) => (isGeneratedVisual(s.kind) ? { ...s, count: Math.max(1, Math.ceil(s.count / 2)) } : s)),
  )
  // Loop and stretch: generate one clip, then fill the runtime with the free
  // deterministic editor. Only worth offering when the plan wanted several
  // generated visuals, and priced as one video + one edit step on top of every non-visual step (narration, music, lipsync, other edits). Needs a video: stretch_clip cannot loop a still.
  const visualCount = merged.filter((s) => isGeneratedVisual(s.kind)).reduce((n, s) => n + s.count, 0)
  if (visualCount >= 2 && unit.has('video')) {
    let editUnit = unit.get('edit') ?? null
    if (editUnit === null) {
      try { editUnit = await deps.priceMicro('edit') } catch { editUnit = null }
    }
    if (editUnit !== null) {
      const others = cost(merged.filter((s) => !isGeneratedVisual(s.kind)))
      const c = others + (unit.get('video') ?? 0n) + editUnit
      if (c <= available && !seen.has(c)) {
        seen.add(c)
        result.options.push({
          label: 'Loop and stretch',
          description: 'Generate one short clip, then loop or slow it across the full runtime with the editor. Reuses the same footage instead of a unique scene per moment.',
          costCredits: toCredits(c),
        })
      }
    }
  }
  result.options.push({
    label: 'Top up credits',
    description: 'Add credits from the billing page, then run the full plan as originally scoped.',
    costCredits: toCredits(full),
  })
  return result
}

async function priceFromRates(kind: StepKind): Promise<bigint | null> {
  const { jobType, subject } = PRICING[kind]
  const rate = await resolveRate(jobType, subject)
  return rate ? costMicro(rate.schema, { count: 1 }) : null
}

async function readBalanceForTenant(tenantId: string): Promise<BalanceRead> {
  const res = await getPool().query<{ balance_micro: string; unlimited: boolean }>(BALANCE_QUERY, [tenantId])
  const row = res.rows[0]
  return { unlimited: Boolean(row?.unlimited), balanceMicro: BigInt(row?.balance_micro ?? '0') }
}

export const checkCreditPlan = createTool({
  id: 'check-credit-plan',
  description: 'Free, read-only. Prices a planned set of generation steps against the tenant\'s credit balance. Returns the full cost, the balance, any shortfall, and cheaper rule-based options sized to what the balance can cover. Call it before presenting a cost plan for generation. All amounts are in credits.',
  requestContextSchema: tenantContextSchema,
  inputSchema: z.object({
    steps: z.array(z.object({
      kind: z.enum(['image', 'video', 'narration', 'music', 'lipsync', 'lipsync_hq', 'edit']).describe('What is being generated; "lipsync_hq" is the higher-fidelity sync-2.0 lipsync, about 10x the standard "lipsync"; "edit" is any deterministic ffmpeg step (assemble, trim, captions, overlay, mux)'),
      count: z.number().int().min(1).describe('How many separate generations or edit calls of this kind'),
    })).min(1),
  }),
  outputSchema: z.object({
    fullCostCredits: z.number(),
    balanceCredits: z.number().nullable().describe('null when the tenant is unlimited or the balance could not be read'),
    shortfallCredits: z.number(),
    unlimited: z.boolean(),
    balanceUnknown: z.boolean().describe('true when the balance read failed — do not tell the user they are out of credits'),
    unpricedKinds: z.array(z.string()).describe('Step kinds with no active rate; their cost is not included in the total'),
    options: z.array(z.object({
      label: z.string(),
      description: z.string(),
      costCredits: z.number(),
    })),
  }),
  execute: async (inputData, execContext) => {
    const steps = (inputData as { steps: PlanStep[] }).steps
    const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined ?? ''
    return computeCreditPlan(steps, {
      priceMicro: priceFromRates,
      readBalance: () => readBalanceForTenant(tenantId),
    })
  },
})
