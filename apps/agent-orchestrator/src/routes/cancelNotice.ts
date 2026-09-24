// Instant reply for a cancelled generation card.
//
// Declining a tool call makes Mastra resume the run (delegate + Olmo each take
// another model turn, ~15s) before anything reaches the user. For the common
// case — nothing else was generated this turn and the user gave no reason —
// chatStream.ts sends this notice and `done` straight away, then lets the
// declined run finish in the background (the run must finish so Mastra clears
// its snapshot and the thread does not end on an unanswered tool call).

// The user's own words, minus the request boilerplate: "generate an image of
// a tvc character" -> "tvc character". Capped at 8 words.
export function cancelSubject(userMessage: string): string {
  let s = userMessage.trim().replace(/\s+/g, ' ')
  s = s.replace(/^(hey|hi|ok(ay)?|please|pls)[,!]?\s+/i, '')
  s = s.replace(/^(can|could|would) you\s+(please\s+)?/i, '')
  s = s.replace(/^(generate|create|make|draw|render|produce|design|give)\s+(me\s+)?/i, '')
  s = s.replace(/^(an?|the|some|\d+)\s+/i, '')
  s = s.replace(/^(images?|pictures?|photos?|pics?|visuals?|videos?|clips?|songs?|tracks?|voice-?overs?|narrations?)\s+(of|for|showing|with|about)\s+/i, '')
  s = s.replace(/^(an?|the|some)\s+/i, '')
  s = s.replace(/[.!?]+$/, '')
  const words = s.split(' ').filter(Boolean)
  if (words.length === 0) return ''
  return words.length > 8 ? `${words.slice(0, 8).join(' ')}…` : words.join(' ')
}

const RETRY = ' Nothing was generated. Want to change anything and try again?'

export function buildCancelNotice(toolName: string, args: Record<string, unknown>, userMessage: string): string {
  const name = toolName.toLowerCase().replace(/-/g, '_')
  const subject = cancelSubject(userMessage)
  const ar = typeof args.aspectRatio === 'string' && args.aspectRatio ? ` (${args.aspectRatio})` : ''
  const count = Array.isArray(args.items) ? args.items.length : 0

  switch (name) {
    case 'generate_image':
      return (subject ? `Cancelled: ${subject} image${ar}.` : `Cancelled the image${ar}.`) + RETRY
    case 'generate_images':
      return `Cancelled: ${count || 'the'} images${subject ? ` of ${subject}` : ''}${ar}.` + RETRY
    case 'edit_image':
      return `Cancelled the edit${subject ? `: ${subject}` : ''}. The original is unchanged. Want to change anything and try again?`
    case 'generate_video':
      return (subject ? `Cancelled: ${subject} video${ar}.` : `Cancelled the video${ar}.`) + RETRY
    case 'generate_videos':
      return `Cancelled: ${count || 'the'} videos${subject ? ` of ${subject}` : ''}${ar}.` + RETRY
    case 'generate_song':
      return (subject ? `Cancelled: ${subject} song.` : 'Cancelled the song.') + RETRY
    case 'generate_narration':
      return (subject ? `Cancelled: ${subject} voiceover.` : 'Cancelled the voiceover.') + RETRY
    case 'save_skill':
      return 'Skill not saved.'
    default:
      return 'Cancelled. Nothing was changed. Want to change anything and try again?'
  }
}

// Given to the declined run that finishes in the background. The user has
// already seen `notice`; asking both the delegate and Olmo to repeat it keeps
// Olmo's own memory of the turn identical to what the screen shows, and keeps
// both model turns short.
export function backgroundDeclineReason(notice: string): string {
  return `The user chose to cancel this generation. It did not fail. They have already been shown this reply: "${notice}" Do not retry and do not call any tool. Reply with exactly that text and nothing else.`
}

// conversationId -> the declined run still finishing in the background. A new
// message on the same thread waits for it (capped) before starting its own
// run, so two runs never write to one thread's memory at once.
const backgroundDeclines = new Map<string, Promise<void>>()

export function trackBackgroundDecline(conversationId: string, done: Promise<void>): void {
  backgroundDeclines.set(conversationId, done)
  done.finally(() => {
    if (backgroundDeclines.get(conversationId) === done) backgroundDeclines.delete(conversationId)
  })
}

export async function waitForBackgroundDecline(conversationId: string, capMs = 8_000): Promise<'none' | 'finished' | 'timed_out'> {
  const pending = backgroundDeclines.get(conversationId)
  if (!pending) return 'none'
  let timer: ReturnType<typeof setTimeout> | undefined
  const result = await Promise.race([
    pending.then(() => 'finished' as const, () => 'finished' as const),
    new Promise<'timed_out'>((resolve) => { timer = setTimeout(() => resolve('timed_out'), capMs) }),
  ])
  clearTimeout(timer)
  return result
}
