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

  // Skip the approval card when the tool is being called from inside a
  // delegate (Director/Producer/etc). The `tool-call-approval` chunk does
  // propagate up to Olmo's outer stream (Mastra docs say approvals surface at
  // the top-level supervisor), and chatStream.ts's tool-call-approval branch
  // renders the card + waits fine — but the subsequent
  // `agent.approveToolCall({ runId: olmoStream.runId, toolCallId })` fails to
  // resume the delegate's suspended tool call in this version. The resumed
  // stream returns immediately without executing the tool: gateway sees no
  // image request, no credit debit, no upload. User approves the card, then
  // Olmo tells them "the image couldn't be generated" — the DELEGATE_MEDIA
  // guardrail firing on an empty subAgentToolResults.
  //
  // Proper fix is to migrate Olmo→delegate wiring off `Agent.stream()` +
  // `agents:` and onto Mastra's `Agent.network()` primitive, whose
  // `approveNetworkToolCall(toolCallId, { runId, memory })` is designed for
  // delegate-nested resumes. See project_delegate_network_migration memory
  // note for that plan. Until then this bypass runs delegate-issued
  // generations without the cost card — the direct (Olmo-called) generation
  // path still shows and gates on it.
  // TEMPORARY: delegate-approval bypass disabled to test whether the resume
  // actually fails end-to-end. Restore after test.
  // const delegationDepth = (rc?.delegationDepth as number | undefined) ?? 0
  // if (delegationDepth > 0) return false

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
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const MUSIC_MODEL = 'lyria-002'

/**
 * Rebuilds the approval card's display fields from a bare
 * `tool-call-approval` chunk (`{ toolName, args }`) — the native chunk
 * carries neither `resourceType`/`subject`/`label` (all decided per-tool,
 * not derivable from the model's raw args) nor `createSkill`'s computed
 * preview/PII note, so chatStream.ts rebuilds them here at forward time.
 */
// Both hyphenated (tool `id`) and underscored (delegate registration key) forms
// are listed for each generation tool because either can arrive as the
// `toolName` on a `tool-call-approval` chunk: Olmo's direct tool map is keyed
// on the tool's `id` ('generate-image'), but directorAgent/producerAgent
// register the same tools under underscored keys ('generate_image') so the
// model calls them by that name (see directorAgent.ts's comment). Without both
// forms, delegate-triggered approvals fall through to chatStream.ts's
// "unmapped tool" fallback, which then crashes with `resumeStream() cannot
// resume tool call ... because it is not suspended` — Olmo has no suspension
// of its own to resume when the pause lives inside a delegate.
const imageGen = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Generate image' }
const videoGen = { resourceType: 'video_generation', subject: VIDEO_MODEL, label: 'Generate video' }
const songGen = { resourceType: 'music_generation', subject: MUSIC_MODEL, label: 'Generate song' }
const imageEdit = { resourceType: 'image_generation', subject: IMAGE_MODEL, label: 'Edit image' }

export const GENERATION_APPROVAL_METADATA: Record<string, {
  resourceType: string
  subject: string
  label: string
  buildPreview?: (args: Record<string, unknown>) => string | undefined
}> = {
  'generate-image': imageGen,
  'generate_image': imageGen,
  'generate-video': videoGen,
  'generate_video': videoGen,
  'generate-song': songGen,
  'generate_song': songGen,
  'edit-image': imageEdit,
  'edit_image': imageEdit,
  'save_skill': {
    resourceType: 'skill_creation',
    subject: 'create',
    label: 'Save skill',
    buildPreview: (args) => (typeof args.body === 'string' ? buildSkillPreview(args.body) : undefined),
  },
}
