import { eq, and, isNull } from 'drizzle-orm';
import { notificationWorkflows, notificationWorkflowSteps, notificationTemplates } from './schema/notifications';
import type { DB } from './client';

const MESSAGE_TYPES = [
  'task.awaiting_approval',
  'task.completed',
  'task.needs_clarification',
  'task.failed',
  'prd.created',
  'roadmap.created',
  'tasks.created',
] as const;

export async function provisionNotificationWorkflows(
  db: DB,
  tenantId: string,
  userId: string,
): Promise<void> {
  const results = await Promise.allSettled(
    MESSAGE_TYPES.map(async (messageType) => {
      // 1. Skip if workflow already exists for this tenant + messageType
      const existing = await db
        .select({ id: notificationWorkflows.id })
        .from(notificationWorkflows)
        .where(and(
          eq(notificationWorkflows.tenantId, tenantId),
          eq(notificationWorkflows.messageType, messageType),
        ))
        .limit(1);

      if (existing.length > 0) {
        return;
      }

      // 2. Look up system-level template (tenantId IS NULL)
      const templates = await db
        .select({ id: notificationTemplates.id })
        .from(notificationTemplates)
        .where(and(
          eq(notificationTemplates.name, messageType),
          eq(notificationTemplates.channel, 'in_app'),
          isNull(notificationTemplates.tenantId),
        ))
        .limit(1);

      if (templates.length === 0) {
        throw new Error(`Template not found: ${messageType}`);
      }

      const template = templates[0];

      // 3. Insert workflow
      const [workflow] = await db
        .insert(notificationWorkflows)
        .values({
          tenantId,
          messageType,
          critical: false,
          status: 'active',
          createdBy: userId,
        })
        .returning({ id: notificationWorkflows.id });

      // 4. Insert single channel step
      await db.insert(notificationWorkflowSteps).values({
        workflowId: workflow.id,
        tenantId,
        order: 1,
        type: 'channel',
        config: { channel: 'in_app' },
        templateId: template.id,
      });
    }),
  );

  const failures = results
    .map((r, i) => ({ result: r, messageType: MESSAGE_TYPES[i] }))
    .filter((x) => x.result.status === 'rejected');

  for (const { result, messageType } of failures) {
    console.error(
      `[provisionNotificationWorkflows] failed for ${messageType}:`,
      (result as PromiseRejectedResult).reason,
    );
  }

  if (failures.length === MESSAGE_TYPES.length) {
    throw new Error('provisionNotificationWorkflows: all 4 message types failed');
  }
}
