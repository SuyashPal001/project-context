// Tells the browser the generation itself has begun. A tool's execute() only runs
// once approval (if any) has been given, so this fires at the right moment in both
// Ask and Auto mode. The client uses it to swap "Preparing…" for the media skeleton:
// before this, the delegate is only reasoning / writing the prompt, and showing a
// generating skeleton then reads as "the image already started".
type SendEvent = (event: string, data: object) => void

// aspectRatio, when the tool has one, lets the client shape the generating
// skeleton like the result (a 9:16 video gets a vertical placeholder).
export function emitGenerationStarted(execContext: unknown, info: { aspectRatio?: unknown } = {}): void {
  const sendEvent = (execContext as { requestContext?: { get: (key: string) => unknown } } | undefined)
    ?.requestContext?.get('sendEvent') as SendEvent | undefined
  const aspectRatio = typeof info.aspectRatio === 'string' && /^\d+:\d+$/.test(info.aspectRatio) ? info.aspectRatio : undefined
  sendEvent?.('generation_started', aspectRatio ? { aspectRatio } : {})
}
