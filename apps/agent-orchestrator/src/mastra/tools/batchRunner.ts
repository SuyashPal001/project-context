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

export async function runBatch<TItem>(
  items: TItem[],
  runItem: (item: TItem, index: number) => Promise<Record<string, unknown>>,
): Promise<BatchResult> {
  const settled = await Promise.allSettled(items.map((item, index) => runItem(item, index)))
  // Annotated on purpose: without it, spreading a Record<string, unknown> loses
  // the index signature and `r.fileId` below fails to type-check (TS2339).
  const results: BatchResult['results'] = settled.map((s, index) => {
    if (s.status === 'fulfilled') return { index, ...s.value }
    console.error(`[batch] item ${index} threw:`, (s.reason as Error)?.message ?? String(s.reason))
    return { index, refused: true, refusalReason: 'GENERATION_FAILED' }
  })
  const succeeded = results.filter((r) => typeof r.fileId === 'string').length
  return { results, succeeded, failed: results.length - succeeded }
}
