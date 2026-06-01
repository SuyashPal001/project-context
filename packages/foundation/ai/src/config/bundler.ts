/**
 * Config Bundler
 *
 * Loads agent configuration from the database and builds an AgentSessionConfig
 * to pass to the agent runtime on session start.
 *
 * LLM provider fallback chain:
 *   1. Agent's pinned provider (llmProviderId is set on the agent row)
 *   2. Tenant's default provider (isDefault=true for that tenantId)
 *   3. Platform default provider (tenantId IS NULL, isDefault=true)
 */

import { db } from '@serverless-saas/database';
import { eq, and, desc, isNull } from 'drizzle-orm';
import { agents } from '@serverless-saas/agent-schema/agents';
import {
  agentSkills,
  agentPolicies,
  conversations,
  messages,
} from '@serverless-saas/agent-schema/conversations';
import { llmProviders, integrations } from '@serverless-saas/database/schema/integrations';
import type {
  AgentSessionConfig,
  LLMProviderConfig,
  SkillConfig,
  PolicyConfig,
  ConversationMessage,
} from '../runtime/types';

// =============================================================================
// PUBLIC TYPES
// =============================================================================

export interface BundleConfigParams {
  tenantId: string;
  userId: string;
  agentId: string;
  conversationId: string;
  /** How many prior messages to include as context (default: 20) */
  historyLimit?: number;
}

export type BundleConfigResult =
  | { success: true; config: AgentSessionConfig }
  | {
      success: false;
      error: string;
      code:
        | 'AGENT_NOT_FOUND'
        | 'AGENT_INACTIVE'
        | 'NO_SKILL'
        | 'NO_POLICY'
        | 'NO_LLM_PROVIDER'
        | 'CONVERSATION_NOT_FOUND';
    };

// =============================================================================
// MAIN FUNCTION
// =============================================================================

/**
 * Bundle agent configuration for a session.
 *
 * Validates the agent is active, resolves its skill + policy + LLM provider,
 * and loads conversation history. Returns a ready-to-send AgentSessionConfig.
 */
export async function bundleAgentConfig(
  params: BundleConfigParams,
): Promise<BundleConfigResult> {
  const { tenantId, userId, agentId, conversationId, historyLimit = 20 } = params;

  // 1. Load and validate agent
  const agent = await loadAgent(tenantId, agentId);
  if (!agent) {
    return { success: false, error: 'Agent not found', code: 'AGENT_NOT_FOUND' };
  }
  if (agent.status !== 'active') {
    return { success: false, error: `Agent is ${agent.status}`, code: 'AGENT_INACTIVE' };
  }

  // 2. Load active skill (highest version)
  const skill = await loadActiveSkill(tenantId, agentId);
  if (!skill) {
    return {
      success: false,
      error: 'No active skill configured for this agent',
      code: 'NO_SKILL',
    };
  }

  // 3. Load policy
  const policy = await loadPolicy(tenantId, agentId);
  if (!policy) {
    return {
      success: false,
      error: 'No policy configured for this agent',
      code: 'NO_POLICY',
    };
  }

  // 4. Load LLM provider (agent-pinned → tenant default → platform default)
  const provider = await loadLLMProvider(tenantId, agent.llmProviderId ?? null);
  if (!provider) {
    return {
      success: false,
      error: 'No LLM provider available for this tenant',
      code: 'NO_LLM_PROVIDER',
    };
  }

  // 5. Validate conversation belongs to tenant
  const conversation = await loadConversation(tenantId, conversationId);
  if (!conversation) {
    return {
      success: false,
      error: 'Conversation not found',
      code: 'CONVERSATION_NOT_FOUND',
    };
  }

  // 6. Load prior messages for context
  const history = await loadConversationHistory(conversationId, historyLimit);

  // 7. Check whether this tenant has active MCP integrations
  const hasMcpIntegrations = await checkHasMcpIntegrations(tenantId);

  // 8. Assemble config
  const config: AgentSessionConfig = {
    sessionId: crypto.randomUUID(),
    tenantId,
    userId,
    agentId,
    conversationId,

    llmProvider: formatLLMProvider(provider),
    skill: formatSkill(skill),
    policy: formatPolicy(policy),

    conversationHistory: history,

    hasMcpIntegrations,

    callbacks: {
      usageReportUrl: buildUsageReportUrl(tenantId, conversationId),
    },
  };

  return { success: true, config };
}

// =============================================================================
// LOADER FUNCTIONS
// =============================================================================

async function loadAgent(tenantId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), eq(agents.id, agentId)))
    .limit(1);
  return row ?? null;
}

async function loadActiveSkill(tenantId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(
      and(
        eq(agentSkills.tenantId, tenantId),
        eq(agentSkills.agentId, agentId),
        eq(agentSkills.status, 'active'),
      ),
    )
    .orderBy(desc(agentSkills.version))
    .limit(1);
  return row ?? null;
}

async function loadPolicy(tenantId: string, agentId: string) {
  const [row] = await db
    .select()
    .from(agentPolicies)
    .where(
      and(eq(agentPolicies.tenantId, tenantId), eq(agentPolicies.agentId, agentId)),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Resolve LLM provider with three-tier fallback.
 */
async function loadLLMProvider(tenantId: string, agentProviderId: string | null) {
  // Tier 1: agent's pinned provider
  if (agentProviderId) {
    const [row] = await db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, agentProviderId))
      .limit(1);
    if (row) return row;
  }

  // Tier 2: tenant's default
  const [tenantDefault] = await db
    .select()
    .from(llmProviders)
    .where(and(eq(llmProviders.tenantId, tenantId), eq(llmProviders.isDefault, true)))
    .limit(1);
  if (tenantDefault) return tenantDefault;

  // Tier 3: platform default (tenantId IS NULL)
  const [platformDefault] = await db
    .select()
    .from(llmProviders)
    .where(and(isNull(llmProviders.tenantId), eq(llmProviders.isDefault, true)))
    .limit(1);
  return platformDefault ?? null;
}

async function loadConversation(tenantId: string, conversationId: string) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenantId, tenantId), eq(conversations.id, conversationId)))
    .limit(1);
  return row ?? null;
}

type MessageRow = {
  id: string;
  role: string;
  content: string;
  toolCalls: unknown;
  toolResults: unknown;
  createdAt: Date;
};

// Reserve 30K tokens for conversation history; rough 4 chars/token estimate (RELAY-7)
const MAX_CONTEXT_TOKENS = 30_000;
const CHARS_PER_TOKEN = 4;

async function loadConversationHistory(
  conversationId: string,
  limit: number,
): Promise<ConversationMessage[]> {
  const rows: MessageRow[] = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      toolCalls: messages.toolCalls,
      toolResults: messages.toolResults,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);

  // Reverse to chronological order (oldest first) for LLM context
  const chronological = rows.reverse().map((m) => ({
    id: m.id,
    role: m.role as ConversationMessage['role'],
    content: m.content,
    toolCalls: (m.toolCalls as ConversationMessage['toolCalls']) ?? undefined,
    toolResults: (m.toolResults as ConversationMessage['toolResults']) ?? undefined,
    createdAt: m.createdAt.toISOString(),
  }));

  // Trim oldest messages first to fit within token budget
  let tokenBudget = MAX_CONTEXT_TOKENS;
  const included: ConversationMessage[] = [];

  for (let i = chronological.length - 1; i >= 0; i--) {
    const msg = chronological[i];
    const estimated = Math.ceil(msg.content.length / CHARS_PER_TOKEN);
    if (tokenBudget - estimated < 0 && included.length > 0) break;
    tokenBudget -= estimated;
    included.unshift(msg);
  }

  return included;
}

async function checkHasMcpIntegrations(tenantId: string): Promise<boolean> {
  const rows = await db
    .select({ id: integrations.id })
    .from(integrations)
    .where(
      and(
        eq(integrations.tenantId, tenantId),
        eq(integrations.status, 'active'),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

// =============================================================================
// FORMATTER FUNCTIONS
// =============================================================================

function formatLLMProvider(
  provider: typeof llmProviders.$inferSelect,
): LLMProviderConfig {
  // RELAY-2: Never send raw API keys to the VM relay.
  // The VM must have its own LLM credentials configured via its environment.
  // For Vertex AI, send only non-secret location identifiers.
  const credentials: LLMProviderConfig['credentials'] = {};

  if (provider.provider === 'vertex') {
    credentials.projectId = process.env.GCP_PROJECT_ID;
    credentials.location = process.env.GCP_LOCATION;
  }
  // apiKey intentionally omitted for all providers — VM uses its own keys

  return {
    // DB enum is 'openai' | 'anthropic' | 'mistral' | 'openrouter'.
    // LLMProviderConfig also includes 'vertex' for future use.
    provider: provider.provider as LLMProviderConfig['provider'],
    model: provider.model,
    credentials,
  };
}

function formatSkill(skill: typeof agentSkills.$inferSelect): SkillConfig {
  const config = (skill.config ?? {}) as Record<string, unknown>;
  return {
    skillId: skill.id,
    name: skill.name,
    systemPrompt: skill.systemPrompt,
    tools: skill.tools,
    config: {
      temperature: config.temperature as number | undefined,
      maxTokens: config.maxTokens as number | undefined,
      ...config,
    },
  };
}

function formatPolicy(policy: typeof agentPolicies.$inferSelect): PolicyConfig {
  return {
    policyId: policy.id,
    allowedActions: policy.allowedActions,
    blockedActions: policy.blockedActions,
    requiresApproval: policy.requiresApproval,
    limits: {
      maxTokensPerMessage: policy.maxTokensPerMessage ?? undefined,
      maxMessagesPerConversation: policy.maxMessagesPerConversation ?? undefined,
    },
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function buildUsageReportUrl(tenantId: string, conversationId: string): string {
  const baseUrl = process.env.API_BASE_URL ?? '';
  return `${baseUrl}/api/v1/internal/usage/report?tenantId=${tenantId}&conversationId=${conversationId}`;
}
