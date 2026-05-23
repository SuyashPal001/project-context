import { eq, and } from 'drizzle-orm';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { db } from '../db';
import { agentWorkflows, agentWorkflowRuns } from '@serverless-saas/agent-schema';

const RELAY_URL = process.env.RELAY_URL!;
const INTERNAL_SERVICE_KEY = process.env.INTERNAL_SERVICE_KEY!;
const SQS_PROCESSING_QUEUE_URL = process.env.SQS_PROCESSING_QUEUE_URL;

const sqsClient = new SQSClient({});

async function fireWorkflowEval(
  workflow: typeof agentWorkflows.$inferSelect,
  runId: string,
): Promise<void> {
  if (!SQS_PROCESSING_QUEUE_URL) return;
  try {
    await sqsClient.send(
      new SendMessageCommand({
        QueueUrl: SQS_PROCESSING_QUEUE_URL,
        MessageBody: JSON.stringify({
          type: 'eval.auto',
          payload: {
            conversationId: runId,
            messageId: runId,
            tenantId: workflow.tenantId,
            question: workflow.name,
            retrievedChunks: [],
            answer: workflow.systemPrompt ?? `Workflow "${workflow.name}" scheduled execution completed.`,
          },
        }),
      }),
    );
  } catch (err) {
    // Fire and forget — never block workflow execution
    console.error('[workflowFire] eval.auto publish error:', err instanceof Error ? err.message : String(err));
  }
}

export async function handleWorkflowFire(body: Record<string, unknown>): Promise<void> {
  const workflowId = typeof body.workflowId === 'string' ? body.workflowId : undefined;

  let workflows: (typeof agentWorkflows.$inferSelect)[];

  if (workflowId) {
    workflows = await db
      .select()
      .from(agentWorkflows)
      .where(eq(agentWorkflows.id, workflowId));
  } else {
    workflows = await db
      .select()
      .from(agentWorkflows)
      .where(
        and(
          eq(agentWorkflows.trigger, 'scheduled'),
          eq(agentWorkflows.status, 'active'),
        ),
      );
  }

  for (const workflow of workflows) {
    let runId: string | undefined;
    try {
      const [run] = await db
        .insert(agentWorkflowRuns)
        .values({
          workflowId: workflow.id,
          tenantId: workflow.tenantId,
          agentId: workflow.agentId,
          trigger: 'scheduled',
          status: 'running',
          startedAt: new Date(),
        })
        .returning({ id: agentWorkflowRuns.id });

      runId = run.id;
      const resolvedRunId = run.id;

      const response = await fetch(`${RELAY_URL}/api/workflows/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-service-key': INTERNAL_SERVICE_KEY,
        },
        body: JSON.stringify({
          workflowId: workflow.id,
          workflowRunId: resolvedRunId,
          tenantId: workflow.tenantId,
          agentId: workflow.agentId,
          steps: workflow.steps,
          systemPrompt: workflow.systemPrompt,
          requiresApproval: workflow.requiresApproval,
        }),
        signal: AbortSignal.timeout(55_000),
      });

      if (!response.ok) {
        throw new Error(`Relay responded with ${response.status}`);
      }

      // Run stays 'running' — relay workflow callbacks will update to completed/failed
      // asynchronously via POST /internal/workflows/:workflowRunId/update.
      void fireWorkflowEval(workflow, resolvedRunId);
    } catch (err) {
      console.error(
        '[workflowFire] error for workflow',
        workflow.id,
        ':',
        err instanceof Error ? err.message : String(err),
      );
      if (runId) {
        try {
          await db
            .update(agentWorkflowRuns)
            .set({ status: 'failed', completedAt: new Date() })
            .where(eq(agentWorkflowRuns.id, runId));
        } catch (updateErr) {
          console.error(
            '[workflowFire] failed to update run status:',
            updateErr instanceof Error ? updateErr.message : String(updateErr),
          );
        }
      }
    }
  }
}
