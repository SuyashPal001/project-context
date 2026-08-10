import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db } from '@serverless-saas/database'
import { getMcpRegistry } from '@serverless-saas/mcp'
import { registerAgentPlatformMcpTools } from '@serverless-saas/agent-capabilities'
import { resolveUserPermissions } from '@serverless-saas/permissions'

// Registers start_task/get_task_thread on the shared McpToolRegistry (idempotent —
// registerAgentPlatformMcpTools() guards against double-registration internally).
// This lets the in-app platform agent call the same handlers the MCP server exposes
// to external agents, but as plain in-process function calls — no MCP protocol, no
// network hop.
registerAgentPlatformMcpTools()

const TOOL_NAMES = ['start_task', 'get_task_thread'] as const

function buildTool(name: (typeof TOOL_NAMES)[number]) {
  return createTool({
    id: name,
    description: getMcpRegistry()?.getDefinition(name)?.description ?? name,
    inputSchema: z.object({ taskId: z.string().describe('The task ID') }),
    execute: async (inputData, execContext) => {
      const tenantId = execContext?.requestContext?.get('tenantId') as string | undefined
      const userId = execContext?.requestContext?.get('userId') as string | undefined

      if (!tenantId || !userId) {
        return { content: [{ type: 'text' as const, text: 'No authenticated session for this request.' }] }
      }

      // Human/session caller — no agentId set, so Task 4's agent_tool_assignments
      // gate never fires for this path; the caller is checked purely on role
      // permission, resolved from their tenant membership.
      const resolved = await resolveUserPermissions(db, tenantId, userId)
      const permissions = (resolved ?? []).map((p) => `${p.resource}:${p.action}`)

      const result = await getMcpRegistry().execute(
        { name, arguments: inputData },
        { tenantId, keyId: 'session', keyType: 'rest', permissions },
      )

      return { content: result.content }
    },
  })
}

export const platformCapabilityTools = Object.fromEntries(
  TOOL_NAMES.map((name) => [name, buildTool(name)]),
) as Record<(typeof TOOL_NAMES)[number], ReturnType<typeof buildTool>>
