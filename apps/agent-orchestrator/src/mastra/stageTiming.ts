// Per-stage timing for the slow gap before a turn's first chunk. Logs
// `[timing:<sessionId>] <label> <ms>ms`; grep that prefix on the VM.
// `unknown` so any RequestContext<T> fits; only `.get('sessionId')` is read.
type Ctx = unknown

export async function timed<T>(label: string, requestContext: Ctx, fn: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await fn()
  } finally {
    const ctx = requestContext as { get?: (key: string) => unknown } | undefined
    const sessionId = (ctx?.get?.('sessionId') as string | undefined) ?? 'none'
    console.log(`[timing:${sessionId}] ${label} ${Date.now() - started}ms`)
  }
}
