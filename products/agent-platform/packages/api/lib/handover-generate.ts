import { and, eq, max } from 'drizzle-orm';
import { db } from '../db';
import { agentTasks } from '@serverless-saas/agent-schema/agents';
import { packItems } from '@serverless-saas/agent-schema/handover';

interface AcceptanceCriterion {
  text: string;
  checked: boolean;
}

function renderDescription(task: { description: string | null; acceptanceCriteria: unknown }): string | null {
  const criteria = Array.isArray(task.acceptanceCriteria) ? (task.acceptanceCriteria as AcceptanceCriterion[]) : [];
  const parts: string[] = [];
  if (task.description) parts.push(task.description);
  if (criteria.length > 0) {
    parts.push(criteria.map((c) => `- ${c.text}`).join('\n'));
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Populates a pack's "Delivered items" section from this plan's completed
 * tasks. Additive only: a task that already has a packItems row (matched by
 * sourceType='task' + sourceId) is skipped, so re-running this (via Sync)
 * never overwrites an item the agency has already corrected. Returns the
 * number of items inserted.
 */
export async function generateDeliveredItems(
  tenantId: string,
  planId: string,
  packId: string,
  sectionId: string,
): Promise<number> {
  const doneTasks = await db
    .select({
      id: agentTasks.id,
      title: agentTasks.title,
      description: agentTasks.description,
      acceptanceCriteria: agentTasks.acceptanceCriteria,
    })
    .from(agentTasks)
    .where(and(
      eq(agentTasks.tenantId, tenantId),
      eq(agentTasks.planId, planId),
      eq(agentTasks.status, 'done'),
    ));

  if (doneTasks.length === 0) return 0;

  const existing = await db
    .select({ sourceId: packItems.sourceId })
    .from(packItems)
    .where(and(eq(packItems.packId, packId), eq(packItems.sourceType, 'task')));
  const alreadyRepresented = new Set(existing.map((row) => row.sourceId));

  const toInsert = doneTasks.filter((task) => !alreadyRepresented.has(task.id));
  if (toInsert.length === 0) return 0;

  const [{ value: maxSortOrder }] = await db
    .select({ value: max(packItems.sortOrder) })
    .from(packItems)
    .where(eq(packItems.sectionId, sectionId));
  let nextSortOrder = (maxSortOrder ?? -1) + 1;

  await db.insert(packItems).values(toInsert.map((task) => ({
    tenantId,
    packId,
    sectionId,
    title: task.title,
    description: renderDescription(task),
    statusLabel: 'Delivered',
    sourceType: 'task' as const,
    sourceId: task.id,
    sortOrder: nextSortOrder++,
  })));

  return toInsert.length;
}
