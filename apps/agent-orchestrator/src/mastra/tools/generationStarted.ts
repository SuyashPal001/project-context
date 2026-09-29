// Tells the browser the generation itself has begun. A tool's execute() only runs
// once approval (if any) has been given, so this fires at the right moment in both
// Ask and Auto mode. The client uses it to swap "Preparing…" for the media skeleton:
// before this, the delegate is only reasoning / writing the prompt, and showing a
// generating skeleton then reads as "the image already started".
type SendEvent = (event: string, data: object) => void

// aspectRatio, when the tool has one, lets the client shape the generating
// skeleton like the result (a 9:16 video gets a vertical placeholder).
// count, for a batch call (generate_images/generate_videos), is the number of
// items in the batch — lets the client render N skeleton tiles from the very
// first event, instead of waiting for batch_item_progress events to infer N.
export function emitGenerationStarted(execContext: unknown, info: { aspectRatio?: unknown; count?: unknown } = {}): void {
  const sendEvent = (execContext as { requestContext?: { get: (key: string) => unknown } } | undefined)
    ?.requestContext?.get('sendEvent') as SendEvent | undefined
  const aspectRatio = typeof info.aspectRatio === 'string' && /^\d+:\d+$/.test(info.aspectRatio) ? info.aspectRatio : undefined
  const count = typeof info.count === 'number' && Number.isInteger(info.count) && info.count > 0 ? info.count : undefined
  const data: { aspectRatio?: string; count?: number } = {}
  if (aspectRatio) data.aspectRatio = aspectRatio
  if (count) data.count = count
  sendEvent?.('generation_started', data)
}

// A short live line for the user during a silent stretch of a delegate's work
// (writing prompts, saving) — shown on the running card in place of the
// generic "Preparing…". `details` are optional sub-lines, e.g. one per person
// about to be generated. Real information only, never filler.
export function emitToolStatus(execContext: unknown, text: string, details?: string[]): void {
  const sendEvent = (execContext as { requestContext?: { get: (key: string) => unknown } } | undefined)
    ?.requestContext?.get('sendEvent') as SendEvent | undefined
  sendEvent?.('tool_status', details?.length ? { text, details } : { text })
}
