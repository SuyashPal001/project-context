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
const VIDEO_MODEL = 'google/gemini-omni-1.1-flash'
const MUSIC_MODEL = 'lyria-002'
const NARRATION_MODEL = 'sonic-3.5'
const LIPSYNC_MODEL = 'fal-ai/latentsync'
const ASSEMBLY_SUBJECT = 'ffmpeg-local'
const MUX_BEAT_AUDIO_SUBJECT = 'ffmpeg-mux-audio'
const TRANSCRIBE_SUBJECT = 'gemini-transcribe'
const COMPOSITE_END_CARD_SUBJECT = 'ffmpeg-composite-end-card'
const BURN_CAPTIONS_SUBJECT = 'ffmpeg-burn-captions'
const MIX_MUSIC_BED_SUBJECT = 'ffmpeg-mix-music-bed'
const TRIM_CLIP_SUBJECT = 'ffmpeg-trim-clip'
const OVERLAY_TEXT_SUBJECT = 'ffmpeg-overlay-text'
const STRETCH_CLIP_SUBJECT = 'ffmpeg-stretch-clip'

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
const narrationGen = { resourceType: 'narration_generation', subject: NARRATION_MODEL, label: 'Generate narration' }
const lipsyncGen = { resourceType: 'lipsync_generation', subject: LIPSYNC_MODEL, label: 'Lip-sync video' }
const assemblyGen = { resourceType: 'clip_assembly', subject: ASSEMBLY_SUBJECT, label: 'Assemble clips' }
const muxBeatAudioGen = { resourceType: 'clip_assembly', subject: MUX_BEAT_AUDIO_SUBJECT, label: 'Mux beat audio' }
const transcribeAudioGen = { resourceType: 'audio_transcription', subject: TRANSCRIBE_SUBJECT, label: 'Transcribe audio' }
const compositeEndCardGen = { resourceType: 'clip_assembly', subject: COMPOSITE_END_CARD_SUBJECT, label: 'Composite end card' }
const burnCaptionsGen = { resourceType: 'clip_assembly', subject: BURN_CAPTIONS_SUBJECT, label: 'Burn captions' }
const mixMusicBedGen = { resourceType: 'clip_assembly', subject: MIX_MUSIC_BED_SUBJECT, label: 'Mix music bed' }
const trimClipGen = { resourceType: 'clip_assembly', subject: TRIM_CLIP_SUBJECT, label: 'Trim clip' }
const overlayTextGen = { resourceType: 'clip_assembly', subject: OVERLAY_TEXT_SUBJECT, label: 'Overlay text' }
const stretchClipGen = { resourceType: 'clip_assembly', subject: STRETCH_CLIP_SUBJECT, label: 'Stretch clip' }

const itemCount = (args: Record<string, unknown>): number | undefined =>
  Array.isArray(args.items) ? args.items.length : undefined
const videoBatchGen = { ...videoGen, label: 'Generate videos', buildCount: itemCount }
const imageBatchGen = { ...imageGen, label: 'Generate images', buildCount: itemCount }

export const GENERATION_APPROVAL_METADATA: Record<string, {
  resourceType: string
  subject: string
  label: string
  buildPreview?: (args: Record<string, unknown>) => string | undefined
  buildCount?: (args: Record<string, unknown>) => number | undefined
}> = {
  'generate-image': imageGen,
  'generate_image': imageGen,
  'generate-video': videoGen,
  'generate_video': videoGen,
  'generate-song': songGen,
  'generate_song': songGen,
  'edit-image': imageEdit,
  'edit_image': imageEdit,
  'generate-videos': videoBatchGen,
  'generate_videos': videoBatchGen,
  'generate-images': imageBatchGen,
  'generate_images': imageBatchGen,
  'generate-narration': narrationGen,
  'generate_narration': narrationGen,
  'lipsync': lipsyncGen, // single key: the tool id and the delegate map key are the same bare word — no hyphenated/underscored forms to differ
  'assemble-clips': assemblyGen,
  'assemble_clips': assemblyGen,
  'mux-beat-audio': muxBeatAudioGen,
  'mux_beat_audio': muxBeatAudioGen,
  'trim-clip': trimClipGen,
  'trim_clip': trimClipGen,
  'overlay-text': overlayTextGen,
  'overlay_text': overlayTextGen,
  'stretch-clip': stretchClipGen,
  'stretch_clip': stretchClipGen,
  'transcribe-audio': transcribeAudioGen,
  'transcribe_audio': transcribeAudioGen,
  'composite-end-card': compositeEndCardGen,
  'composite_end_card': compositeEndCardGen,
  'burn-captions': burnCaptionsGen,
  'burn_captions': burnCaptionsGen,
  'mix-music-bed': mixMusicBedGen,
  'mix_music_bed': mixMusicBedGen,
  'save_skill': {
    resourceType: 'skill_creation',
    subject: 'create',
    label: 'Save skill',
    buildPreview: (args) => (typeof args.body === 'string' ? buildSkillPreview(args.body) : undefined),
  },
}
