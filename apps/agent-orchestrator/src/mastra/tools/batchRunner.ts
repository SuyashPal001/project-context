export const MAX_BATCH_ITEMS = 4

// The slice of Mastra's tool execution context the media item functions read.
// Structural on purpose so tests can pass a bare { requestContext } object.
export type MediaExecContext = {
  requestContext?: { get: (key: string) => unknown }
  agent?: { toolCallId?: string }
}

export type BatchResult = {
  results: Array<Record<string, unknown> & { index: number }>
  succeeded: number
  failed: number
}

// Fired as each item settles, not batched until the whole call returns — lets
// a caller stream per-item progress (e.g. an SSE event) while the other items
// in the batch are still running, since Promise.allSettled itself only
// resolves once every item is done.
export type BatchItemProgress = (index: number, total: number, item: Record<string, unknown> & { index: number }) => void

// Builds the onItemSettled callback shared by generateImages.ts/generateVideos.ts
// so the sendEvent/toolCallId plumbing and event shape live in one place —
// both callers wire this the same way, from the same execContext shape.
export function batchProgressEmitter(
  sendEvent: ((event: string, data: object) => void) | undefined,
  toolCallId: string | undefined,
): BatchItemProgress | undefined {
  if (!sendEvent || !toolCallId) return undefined
  return (index, total, item) => sendEvent('batch_item_progress', {
    toolCallId, index, total,
    status: typeof item.fileId === 'string' ? 'done' : 'failed',
    fileId: item.fileId,
  })
}

export async function runBatch<TItem>(
  items: TItem[],
  runItem: (item: TItem, index: number) => Promise<Record<string, unknown>>,
  onItemSettled?: BatchItemProgress,
): Promise<BatchResult> {
  const total = items.length
  const settled = await Promise.allSettled(items.map((item, index) =>
    runItem(item, index).then(
      (value) => {
        const entry = { index, ...value }
        onItemSettled?.(index, total, entry)
        return value
      },
      (err) => {
        console.error(`[batch] item ${index} threw:`, (err as Error)?.message ?? String(err))
        onItemSettled?.(index, total, { index, refused: true, refusalReason: 'GENERATION_FAILED' })
        throw err
      },
    )))
  // Annotated on purpose: without it, spreading a Record<string, unknown> loses
  // the index signature and `r.fileId` below fails to type-check (TS2339).
  const results: BatchResult['results'] = settled.map((s, index) => {
    if (s.status === 'fulfilled') return { index, ...s.value }
    return { index, refused: true, refusalReason: 'GENERATION_FAILED' }
  })
  const succeeded = results.filter((r) => typeof r.fileId === 'string').length
  return { results, succeeded, failed: results.length - succeeded }
}
