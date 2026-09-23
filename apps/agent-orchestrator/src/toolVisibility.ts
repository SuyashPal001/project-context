// Mastra's built-in working-memory writes surface as regular tool calls in the
// stream, but they are internal bookkeeping the user does not need to see in
// the chat UI. The tools still run — we just do not relay their tool_call /
// tool_done events to clients. Kept as a set (not a regex) because we want
// exact matches on the exact names Mastra emits (see
// @mastra/core dist: UPDATE_WORKING_MEMORY_TOOL_NAME and the
// setWorkingMemory / update-working-memory aliases).
const HIDDEN_STREAM_TOOL_NAMES = new Set([
  'updateworkingmemory',
  'setworkingmemory',
  'update-working-memory',
  'set-working-memory',
])

export function isClientHiddenTool(toolName: string | undefined | null): boolean {
  if (!toolName) return false
  return HIDDEN_STREAM_TOOL_NAMES.has(toolName.toLowerCase().replace(/_/g, '-'))
}
