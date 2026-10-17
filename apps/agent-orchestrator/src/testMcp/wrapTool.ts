// Route 1 of the internal test MCP: Claude calls a product tool directly.
// Tools read tenant, user, conversation and id token from requestContext and
// the call id from agent.toolCallId (generateVideo.ts explains why: a missing
// id makes every later charge in the conversation dedupe to free). MCP gives
// neither, so this wrapper supplies them from the test identity. Arguments
// can never choose the tenant.
//
// sessionId is set the same way, to a fresh mcp-<uuid> per call: analyze_video,
// analyze_image and analyze_audio hard-gate on `!idToken || !sessionId` and
// return 'no_active_session' without one (analyzeVideo.ts:34-35, analyzeImage.ts
// :23,25, analyzeAudio.ts:67-68); break_down_video/compare_to_reference/fetch_video
// /watch_video/measure_pose fall back to sessionId as conversationId/scopeId when
// those aren't set. None of these wait on a live chat channel keyed by sessionId —
// they only use it for the gate check and as a cache/scope key (grepped every
// `get('sessionId')` in src/mastra/tools; the only sendEvent-bearing tools are
// generation tools, whose sendEvent/tool_status/batch_item_progress calls are all
// `sendEvent?.(...)` no-ops, and shouldRequireApproval, which short-circuits on
// missing sendEvent and again on allowMode 'auto' below it).
//
// sendEvent itself is deliberately never set — there is no live chat channel on
// route 1 to push events into, and shouldRequireApproval's approval gate (above)
// needs it absent or 'auto' allowMode to return false rather than hang waiting
// for a browser that doesn't exist.
import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { RequestContext } from '@mastra/core/request-context'
import { fetchTenantBrand } from '../usage.js'

export type TestToolContext = { tenantId: string; userId: string; agentId: string; conversationId: string; idToken: string }

export function wrapForTest(name: string, tool: any, ctx: () => Promise<TestToolContext>): any {
  return createTool({
    id: name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    // Other createTool options on `tool` (requireApproval, toModelOutput, transform,
    // mcp annotations, etc.) are deliberately not forwarded. requireApproval is
    // dropped on purpose: on route 1 Claude is the approver and the test tenant's
    // balance is the hard cap, so there is no card to show and nothing to wait on.
    // Everything else just isn't carried over — a tool whose correctness depends
    // on one of those options needs to be checked before relying on route 1.
    execute: async (input: unknown, mcpCtx: any) => {
      const c = await ctx()
      const requestContext = new RequestContext()
      requestContext.set('tenantId', c.tenantId)
      requestContext.set('userId', c.userId)
      requestContext.set('agentId', c.agentId)
      requestContext.set('conversationId', c.conversationId)
      requestContext.set('idToken', c.idToken)
      requestContext.set('allowMode', 'auto')
      requestContext.set('sessionId', `mcp-${randomUUID()}`)
      // The saved brand, as a live chat turn loads it: update_brand edits its lists
      // and composite_end_card takes its logo. A failed read runs as "no brand".
      requestContext.set('brand', await fetchTenantBrand(c.tenantId).catch(() => null))
      return tool.execute(input, {
        ...mcpCtx,
        requestContext,
        // agentId is required by AgentToolExecutionContext (node_modules/@mastra/core/dist/tools/types.d.ts);
        // no real tool reads it off `agent` (they read requestContext.get('agentId') instead), so this is a no-op value.
        agent: { agentId: c.agentId, toolCallId: `mcp-${randomUUID()}`, messages: [], suspend: async () => {} },
      })
    },
  })
}
