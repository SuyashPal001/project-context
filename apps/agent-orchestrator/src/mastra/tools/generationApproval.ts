import { isUnlimited, resolveRate } from '@serverless-saas/credits'
import { filterPII } from '../../pii-filter.js'

/**
 * Shared predicate behind every generation tool's `requireApproval`. Runs
 * before Mastra decides whether to pause the tool call, so it must stay a
 * pure boolean — no SSE push, no waiting. The wait itself now happens in
 * chatStream.ts's turn loop, driven by the `tool-call-approval` chunk this
 * `true` return causes Mastra to emit.
 */
export async function shouldRequireApproval(
  opts: { resourceType: string; subject: string },
  ctx?: { requestContext?: Record<string, unknown> },
): Promise<boolean> {
  const rc = ctx?.requestContext
  const tenantId = (rc?.tenantId as string | undefined) ?? ''
  const sendEvent = rc?.sendEvent as ((event: string, data: object) => void) | undefined
  const sessionId = rc?.sessionId as string | undefined
  const userId = rc?.userId as string | undefined

  // Mirrors confirmGenerationOrDecline's own guard: not reachable today
  // (these tools only run via chatStream.ts's live SSE path), kept so a
  // future non-SSE caller (e.g. a background task) doesn't hang waiting
  // for a card nothing can show.
  if (!sendEvent || !sessionId || !tenantId || !userId) return false

  if (await isUnlimited(tenantId)) return false

  const allowMode = rc?.allowMode as string | undefined
  if (allowMode === 'auto') return false

  const rate = await resolveRate(opts.resourceType, opts.subject)
  if (!rate) return false

  return true
}

/** How much of a drafted SKILL.md the approval card shows. */
const PREVIEW_MAX_CHARS = 800
const PREVIEW_MAX_LINES = 16

export function buildSkillPreview(body: string): string {
  const lines = body.split(/\r?\n/)
  let preview = lines.slice(0, PREVIEW_MAX_LINES).join('\n')
  if (preview.length > PREVIEW_MAX_CHARS) preview = preview.slice(0, PREVIEW_MAX_CHARS)
  return preview.length < body.length ? `${preview.trimEnd()}\n…` : preview
}

export function detectSkillPii(body: string): string {
  const pii = filterPII(body)
  return pii.detections.length > 0
    ? ` — personal data detected: ${[...new Set(pii.detections.map((d) => d.type))].join(', ')}`
    : ''
}

const IMAGE_MODEL = 'gemini-3-pro-image-preview'
const VIDEO_MODEL = 'gemini-omni-1.1-flash'
const MUSIC_MODEL = 'lyria-002'

/**
 * Rebuilds the approval card's display fields from a bare
 * `tool-call-approval` chunk (`{ toolName, args }`) — the native chunk
 * carries neither `resourceType`/`subject`/`label` (all decided per-tool,
 * not derivable from the model's raw args) nor `createSkill`'s computed
 * preview/PII note, so chatStream.ts rebuilds them here at forward time.
 */
export const GENERATION_APPROVAL_METADATA: Record<string, {
  resourceType: string
  subject: string
  label: string
  buildPreview?: (args: Record<string, unknown>) => string | undefined
}> = {
  'generate-image': { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Generate image' },
  'generate-video': { resourceType: 'video_generation', subject: VIDEO_MODEL, label: 'Generate video' },
  'generate-song': { resourceType: 'music_generation', subject: MUSIC_MODEL, label: 'Generate song' },
  'edit-image': { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Edit image' },
  'create_skill': {
    resourceType: 'skill_creation',
    subject: 'create',
    label: 'Create skill',
    buildPreview: (args) => (typeof args.body === 'string' ? buildSkillPreview(args.body) : undefined),
  },
}
