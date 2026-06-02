/**
 * Usage Recorder
 *
 * Records agent usage metrics to the usage_records table.
 * Each metric from a UsageReport becomes a separate row for flexible
 * billing queries and quota enforcement.
 *
 * Note: usage_records has no metadata column — conversationId/sessionId
 * are available on UsageContext for logging only.
 */

import { db } from '@serverless-saas/database';
import { usageRecords } from '@serverless-saas/database/schema/billing';
import type { UsageReport } from '../runtime/types';

// =============================================================================
// TYPES
// =============================================================================

export interface UsageContext {
  tenantId: string;
  agentId: string;
  userId: string;
  conversationId: string;
  sessionId: string;
}

export type UsageMetric =
  | 'llm_input_tokens'
  | 'llm_output_tokens'
  | 'llm_total_tokens'
  | 'llm_calls'
  | 'tool_calls'
  | 'agent_session_duration_ms'
  | 'agent_sessions';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Record all metrics from an agent session's usage report.
 * Inserts one row per non-zero metric in a single batch query.
 *
 * Safe to call after sendMessage — skips silently if usage is empty.
 */
export async function recordAgentUsage(
  context: UsageContext,
  usage: UsageReport,
): Promise<void> {
  const { tenantId, agentId, conversationId, sessionId } = context;

  type InsertRow = typeof usageRecords.$inferInsert;
  const rows: InsertRow[] = [];

  const row = (metric: string, quantity: number): InsertRow => ({
    tenantId,
    actorId: agentId,
    actorType: 'agent',
    metric,
    quantity: String(quantity),
  });

  if (usage.inputTokens > 0)  rows.push(row('llm_input_tokens',           usage.inputTokens));
  if (usage.outputTokens > 0) rows.push(row('llm_output_tokens',          usage.outputTokens));
  if (usage.totalTokens > 0)  rows.push(row('llm_total_tokens',           usage.totalTokens));
  if (usage.llmCalls > 0)     rows.push(row('llm_calls',                  usage.llmCalls));
  if (usage.toolCalls > 0)    rows.push(row('tool_calls',                 usage.toolCalls));
  if (usage.durationMs > 0)   rows.push(row('agent_session_duration_ms',  usage.durationMs));

  if (rows.length === 0) return;

  await db.insert(usageRecords).values(rows);

  console.log(
    `[UsageRecorder] ${rows.length} metrics for session=${sessionId} conv=${conversationId}`,
  );
}

/**
 * Record a single ad-hoc metric.
 */
export async function recordMetric(
  context: UsageContext,
  metric: UsageMetric,
  quantity: number,
): Promise<void> {
  const { tenantId, agentId } = context;

  await db.insert(usageRecords).values({
    tenantId,
    actorId: agentId,
    actorType: 'agent',
    metric,
    quantity: String(quantity),
  });
}

/**
 * Record session start for analytics (counts total sessions per tenant).
 */
export async function recordSessionStart(context: UsageContext): Promise<void> {
  await recordMetric(context, 'agent_sessions', 1);
}
