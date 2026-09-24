// Mastra's built-in working-memory writes surface as regular tool calls in the
// stream, but they are internal bookkeeping the user does not need to see in
// the chat UI. The tools still run — we just do not relay their tool_call /
// tool_done events to clients. Uses @mastra/core's own isWorkingMemoryToolName
// rather than a hand-rolled name set, per CLAUDE.md's Mastra section — verified
// this call site's toolName always arrives as the exact camelCase name off
// Mastra's native tool-call chunk (chatStream.ts's p.toolName), never a
// hyphenated/underscored wire variant, so no extra normalization is needed.
import { isWorkingMemoryToolName } from '@mastra/core/memory'

export function isClientHiddenTool(toolName: string | undefined | null): boolean {
  return isWorkingMemoryToolName(toolName)
}
