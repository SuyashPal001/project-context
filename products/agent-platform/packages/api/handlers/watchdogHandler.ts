import type { ScheduledHandler } from 'aws-lambda';
import { agentTasks, taskEvents } from '@serverless-saas/agent-schema';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { db } from '../db';
import { eq, and, sql } from 'drizzle-orm';
import { getCacheClient } from '@serverless-saas/cache';
import { pushWebSocketEvent } from '../lib/websocket';
import { publishToQueue } from '@serverless-saas/queue';
import { initRuntimeSecrets } from '@serverless-saas/secrets';
import { taskHeartbeatKey } from '../lib/task-heartbeat';

const wlog = (level: 'info' | 'warn' | 'error', msg: string, data?: Record<string, unknown>) =>
  console.log(JSON.stringify({ level, msg, component: 'watchdog', ts: Date.now(), ...data }));

let secretsInitialised = false;

export const handler: ScheduledHandler = async () => {
  if (!secretsInitialised) {
    await initRuntimeSecrets();
    secretsInitialised = true;
  }

  const sqsUrl = process.env.SQS_PROCESSING_QUEUE_URL;

  // --- Sweep 1: Stalled in_progress tasks (Redis watchdog key expired) ---
  const inProgressTasks = await db
    .select({
      id: agentTasks.id,
      tenantId: agentTasks.tenantId,
      agentId: agentTasks.agentId,
      createdBy: agentTasks.createdBy,
      title: agentTasks.title,
      status: agentTasks.status,
    })
    .from(agentTasks)
    .where(eq(agentTasks.status, 'in_progress'));

  if (inProgressTasks.length > 0) {
    const cache = getCacheClient();
    const stalled: typeof inProgressTasks = [];

    // Upstash is HTTP-based, so one await per task is one HTTPS round trip.
    // Serially that is O(N) round trips every 5 minutes against a 120s Lambda
    // timeout — fine at today's volume, a timeout as task count grows. Batched
    // so the wall-clock cost scales with batches rather than tasks, while
    // staying bounded enough not to open hundreds of sockets at once.
    const HEARTBEAT_CHECK_BATCH = 25;
    for (let i = 0; i < inProgressTasks.length; i += HEARTBEAT_CHECK_BATCH) {
      const batch = inProgressTasks.slice(i, i + HEARTBEAT_CHECK_BATCH);
      const present = await Promise.all(
        batch.map((task) => cache.exists(taskHeartbeatKey(task.id)).catch(() => 1)),
      );
      batch.forEach((task, idx) => {
        // On a cache error we assume the heartbeat is alive: wrongly blocking a
        // running task is worse than deferring the check to the next sweep.
        if (!present[idx]) stalled.push(task);
      });
    }

    if (stalled.length > 0) {
      wlog('info', 'Stalled tasks detected', { count: stalled.length, taskIds: stalled.map((t: { id: string }) => t.id) });

      const reason = 'Task timed out. The agent may have crashed. Please retry.';

      for (const task of stalled) {
        wlog('info', 'Blocking stalled task', { taskId: task.id, tenantId: task.tenantId });

        // BUG-15+16: Add status predicate so the update is a no-op if:
        // (a) two watchdog invocations overlap and one already wrote 'blocked', or
        // (b) the agent finished just before the watchdog fired and set the task to
        //     'review'/'done'. In either case skip all notifications — another process
        //     already handled this task.
        const [updated] = await db.update(agentTasks)
          .set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() })
          .where(and(
            eq(agentTasks.id, task.id),
            eq(agentTasks.status, 'in_progress'),
          ))
          .returning({ id: agentTasks.id });

        if (!updated) {
          wlog('info', 'Task no longer in_progress, skipping notification', { taskId: task.id });
          continue;
        }

        await db.insert(taskEvents).values({
          taskId: task.id,
          tenantId: task.tenantId,
          actorType: 'system',
          actorId: 'system',
          eventType: 'status_changed',
          payload: { from: 'in_progress', to: 'blocked', reason },
        });
        db.insert(auditLog).values({ tenantId: task.tenantId, actorId: 'system', actorType: 'system', action: 'task_timed_out', resource: 'agent_task', resourceId: task.id, metadata: { reason, from: 'in_progress', to: 'blocked' }, traceId: '' }).catch(() => {});

        try {
          await pushWebSocketEvent(task.tenantId, {
            type: 'task.status.changed',
            taskId: task.id,
            status: 'blocked',
          });
        } catch (wsErr) {
          wlog('error', 'WS push failed', { taskId: task.id, error: (wsErr as Error).message });
        }

        if (sqsUrl) {
          try {
            await publishToQueue(sqsUrl, {
              type: 'notification.fire',
              tenantId: task.tenantId,
              messageType: 'task.failed',
              actorId: 'system',
              actorType: 'system',
              recipientIds: [task.createdBy],
              data: { taskId: task.id, taskTitle: task.title },
            });
          } catch (sqsErr) {
            wlog('error', 'SQS notification publish failed', { taskId: task.id, error: (sqsErr as Error).message });
          }
        }
      }
    }
  }

  // --- Sweep 2: Stale planning tasks (stuck > 10 minutes) ---
  const stalePlanning = await db
    .select({
      id: agentTasks.id,
      tenantId: agentTasks.tenantId,
      createdBy: agentTasks.createdBy,
      title: agentTasks.title,
    })
    .from(agentTasks)
    .where(and(
      eq(agentTasks.status, 'planning'),
      sql`${agentTasks.updatedAt} < NOW() - INTERVAL '10 minutes'`,
    ));

  for (const task of stalePlanning) {
    const reason = 'Planning timed out — relay may be unresponsive.';
    const [updated] = await db.update(agentTasks)
      .set({ status: 'blocked', blockedReason: reason, updatedAt: new Date() })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'planning')))
      .returning({ id: agentTasks.id });

    if (!updated) continue;

    await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'system', actorId: 'system', eventType: 'status_changed', payload: { from: 'planning', to: 'blocked', reason: 'Planning timed out — relay may be unresponsive.' } });
    db.insert(auditLog).values({ tenantId: task.tenantId, actorId: 'system', actorType: 'system', action: 'task_timed_out', resource: 'agent_task', resourceId: task.id, metadata: { reason: 'Planning timed out — relay may be unresponsive.', from: 'planning', to: 'blocked' }, traceId: '' }).catch(() => {});

    wlog('info', 'Planning timed out', { taskId: task.id, tenantId: task.tenantId });

    try {
      await pushWebSocketEvent(task.tenantId, {
        type: 'task.status.changed',
        taskId: task.id,
        status: 'blocked',
      });
    } catch (wsErr) {
      wlog('error', 'WS push failed (planning sweep)', { taskId: task.id, error: (wsErr as Error).message });
    }

    if (sqsUrl) {
      try {
        await publishToQueue(sqsUrl, {
          type: 'notification.fire',
          tenantId: task.tenantId,
          messageType: 'task.failed',
          actorId: 'system',
          actorType: 'system',
          recipientIds: [task.createdBy],
          data: { taskId: task.id, taskTitle: task.title },
        });
      } catch (sqsErr) {
        wlog('error', 'SQS publish failed (planning sweep)', { taskId: task.id, error: (sqsErr as Error).message });
      }
    }
  }

  // --- Sweep 3: Stale awaiting_approval tasks (> 7 days) ---
  const staleApproval = await db
    .select({
      id: agentTasks.id,
      tenantId: agentTasks.tenantId,
      createdBy: agentTasks.createdBy,
      title: agentTasks.title,
    })
    .from(agentTasks)
    .where(and(
      eq(agentTasks.status, 'awaiting_approval'),
      sql`${agentTasks.updatedAt} < NOW() - INTERVAL '7 days'`,
    ));

  for (const task of staleApproval) {
    const reason = 'Plan approval timed out after 7 days.';
    const [updated] = await db.update(agentTasks)
      .set({ status: 'cancelled', blockedReason: reason, updatedAt: new Date() })
      .where(and(eq(agentTasks.id, task.id), eq(agentTasks.status, 'awaiting_approval')))
      .returning({ id: agentTasks.id });

    if (!updated) continue;

    await db.insert(taskEvents).values({ taskId: task.id, tenantId: task.tenantId, actorType: 'system', actorId: 'system', eventType: 'status_changed', payload: { from: 'awaiting_approval', to: 'cancelled', reason: 'Plan approval timed out after 7 days.' } });
    db.insert(auditLog).values({ tenantId: task.tenantId, actorId: 'system', actorType: 'system', action: 'task_timed_out', resource: 'agent_task', resourceId: task.id, metadata: { reason: 'Plan approval timed out after 7 days.', from: 'awaiting_approval', to: 'cancelled' }, traceId: '' }).catch(() => {});

    wlog('info', 'Approval timed out, cancelling task', { taskId: task.id, tenantId: task.tenantId });

    try {
      await pushWebSocketEvent(task.tenantId, {
        type: 'task.status.changed',
        taskId: task.id,
        status: 'cancelled',
      });
    } catch (wsErr) {
      wlog('error', 'WS push failed (approval sweep)', { taskId: task.id, error: (wsErr as Error).message });
    }
  }
};
