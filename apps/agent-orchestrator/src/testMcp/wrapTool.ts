// Route 1 of the internal test MCP: Claude calls a product tool directly.
// Tools read tenant, user, conversation and id token from requestContext and
// the call id from agent.toolCallId (generateVideo.ts explains why: a missing
// id makes every later charge in the conversation dedupe to free). MCP gives
// neither, so this wrapper supplies them from the test identity. Arguments
// can never choose the tenant.
import { randomUUID } from 'node:crypto'
import { createTool } from '@mastra/core/tools'
import { RequestContext } from '@mastra/core/request-context'

export type TestToolContext = { tenantId: string; userId: string; agentId: string; conversationId: string; idToken: string }

export function wrapForTest(name: string, tool: any, ctx: () => Promise<TestToolContext>): any {
  return createTool({
    id: name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    execute: async (input: unknown, mcpCtx: any) => {
      const c = await ctx()
      const requestContext = new RequestContext()
      requestContext.set('tenantId', c.tenantId)
      requestContext.set('userId', c.userId)
      requestContext.set('agentId', c.agentId)
      requestContext.set('conversationId', c.conversationId)
      requestContext.set('idToken', c.idToken)
      requestContext.set('allowMode', 'auto')
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
