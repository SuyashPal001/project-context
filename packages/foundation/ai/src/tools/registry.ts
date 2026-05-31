import { eq, and, isNull, inArray, or } from 'drizzle-orm'
import type { DB } from '@serverless-saas/database'
import type { ToolDefinition, ToolRegistryResult } from './types'

// Lazy import to avoid circular deps — caller passes db instance
// Usage: getAgentTools(db, tenantId, agentId, connectedProviders)

export async function getAgentTools(
  db: DB,
  tenantId: string,
  agentId: string,
  connectedProviders: string[] = []
): Promise<ToolRegistryResult> {
  // Dynamically import schema to avoid bundling issues
  const { agentTools, agentToolAssignments } = await import(
    '@serverless-saas/agent-schema'
  )

  // Get tools assigned to this agent for this tenant
  const assigned = await db
    .select({
      id: agentTools.id,
      name: agentTools.name,
      displayName: agentTools.displayName,
      description: agentTools.description,
      provider: agentTools.provider,
      parametersSchema: agentTools.parametersSchema,
      stakes: agentTools.stakes,
      requiresApproval: agentTools.requiresApproval,
      maxRetries: agentTools.maxRetries,
      timeoutMs: agentTools.timeoutMs,
    })
    .from(agentToolAssignments)
    .innerJoin(
      agentTools,
      eq(agentToolAssignments.toolId, agentTools.id)
    )
    .where(
      and(
        eq(agentToolAssignments.agentId, agentId),
        eq(agentToolAssignments.tenantId, tenantId),
        eq(agentTools.status, 'active')
      )
    )

  // Get platform tools (tenantId = null) scoped to connected providers.
  // Generic tools (provider = null, e.g. web_search) are always included.
  // Provider-specific tools (e.g. gmail_*) only included if tenant has
  // that integration connected.
  const platformWhere = connectedProviders.length > 0
    ? and(
        isNull(agentTools.tenantId),
        eq(agentTools.status, 'active'),
        or(
          isNull(agentTools.provider),
          inArray(agentTools.provider, connectedProviders)
        )
      )
    : and(
        isNull(agentTools.tenantId),
        eq(agentTools.status, 'active'),
        isNull(agentTools.provider)
      )

  const platform = await db
    .select({
      id: agentTools.id,
      name: agentTools.name,
      displayName: agentTools.displayName,
      description: agentTools.description,
      provider: agentTools.provider,
      parametersSchema: agentTools.parametersSchema,
      stakes: agentTools.stakes,
      requiresApproval: agentTools.requiresApproval,
      maxRetries: agentTools.maxRetries,
      timeoutMs: agentTools.timeoutMs,
    })
    .from(agentTools)
    .where(platformWhere)

  // Merge — assigned tools take precedence, no duplicates
  const assignedNames = new Set(assigned.map((t: ToolDefinition) => t.name))
  const tools: ToolDefinition[] = [
    ...assigned,
    ...platform.filter((t: ToolDefinition) => !assignedNames.has(t.name)),
  ]

  return {
    tools,
    requiresApprovalTools: tools
      .filter(t => t.requiresApproval)
      .map(t => t.name),
    highStakeTools: tools
      .filter(t => t.stakes === 'high' || t.stakes === 'critical')
      .map(t => t.name),
  }
}

// Get a single tool by name — used for pre-execution validation
export async function getToolByName(
  db: DB,
  name: string
): Promise<ToolDefinition | null> {
  const { agentTools } = await import(
    '@serverless-saas/agent-schema'
  )

  const rows = await db
    .select()
    .from(agentTools)
    .where(
      and(
        eq(agentTools.name, name),
        eq(agentTools.status, 'active')
      )
    )
    .limit(1)

  return rows[0] ?? null
}
