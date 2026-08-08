import { eq, asc } from 'drizzle-orm';
import { db } from '../db';
import { notificationWorkflows, notificationWorkflowSteps } from '@serverless-saas/database';
import { walkSteps } from './notification';

interface NotificationStepEvent {
  type: 'notification.step';
  tenantId: string;
  workflowId: string;
  recipientId: string;
  startFromStepOrder: number;
  payload: Record<string, unknown>;
  stepContext: Record<string, unknown>;
  triggerId: string;
  remainingDelaySeconds?: number;
}

export async function handleStep(body: Record<string, unknown>): Promise<void> {
  const event = body as unknown as NotificationStepEvent;

  // Load workflow to get messageType and critical flag
  const workflows = await db
    .select()
    .from(notificationWorkflows)
    .where(eq(notificationWorkflows.id, event.workflowId))
    .limit(1);

  if (workflows.length === 0) {
    console.log('Workflow not found for step resume', { workflowId: event.workflowId });
    return;
  }

  const workflow = workflows[0];

  // Load all steps
  const steps = await db
    .select()
    .from(notificationWorkflowSteps)
    .where(eq(notificationWorkflowSteps.workflowId, event.workflowId))
    .orderBy(asc(notificationWorkflowSteps.order));

  await walkSteps({
    steps,
    workflowId: event.workflowId,
    tenantId: event.tenantId,
    messageType: workflow.messageType,
    recipientId: event.recipientId,
    isCritical: workflow.critical,
    data: event.payload,
    stepContext: event.stepContext,
    triggerId: event.triggerId,
    startFromOrder: event.startFromStepOrder,
    // Present only while chaining through a delay longer than SQS allows.
    remainingDelaySeconds: event.remainingDelaySeconds,
  });
}
