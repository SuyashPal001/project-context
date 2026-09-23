export const MAX_BATCH_ITEMS = 4

// The slice of Mastra's tool execution context the media item functions read.
// Structural on purpose so tests can pass a bare { requestContext } object.
export type MediaExecContext = {
  requestContext?: { get: (key: string) => unknown }
  agent?: { toolCallId?: string }
}
