import type { ScheduledHandler } from 'aws-lambda';
import { agentTasks, taskEvents, messages } from '@serverless-saas/agent-schema';
import { auditLog } from '@serverless-saas/database/schema/audit';
import { files } from '@serverless-saas/database/schema/storage';
import { db } from '../db';
import { eq, and, sql, inArray } from 'drizzle-orm';
import { getCacheClient } from '@serverless-saas/cache';
import { pushWebSocketEvent } from '../lib/websocket';
import { publishToQueue } from '@serverless-saas/queue';
import { initRuntimeSecrets } from '@serverless-saas/secrets';
import { refundTask, taskChargeKey } from '@serverless-saas/agent-credits';
import { taskHeartbeatKey } from '../lib/task-heartbeat';
import { creditPool } from '../lib/credit-pool';

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
      creditAttempt: agentTasks.creditAttempt,
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

        // A stall means the Redis heartbeat expired — the orchestrator crashed
        // or timed out. That is our infrastructure failing, not the tenant's
        // input, so the tenant pays nothing for a run that produced nothing and
        // we absorb the tokens already burned.
        //
        // This refund is also what advances agent_tasks.credit_attempt. Before
        // it existed the watchdog abandoned a charge silently: the attempt
        // never moved, so the retry rebuilt the SAME charge key, spend_credits()
        // saw a replay and charged nothing, and the first run's tokens were
        // never billed at all. The refund and the bump have to travel together.
        //
        // Awaited but non-fatal: refundTask swallows and logs its own failures,
        // and this outer guard covers a connection-level throw. A task that
        // could not be refunded must not stop the sweep blocking the rest.
        try {
          await refundTask(
            { tenantId: task.tenantId, taskId: task.id, chargeKey: taskChargeKey(task.id, task.creditAttempt) },
            { pool: creditPool },
          );
        } catch (refundErr) {
          wlog('error', 'Stalled-task refund failed', { taskId: task.id, tenantId: task.tenantId, error: (refundErr as Error).message });
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

    // Planning is charged under the `document:{taskId}` namespace by the
    // orchestrator's /api/tasks/:taskId/plan route, not under a task charge
    // key — task charging starts at execution. That route refunds its own
    // failures, but a planning timeout is precisely the case where it never
    // got to run: the relay is unresponsive.
    //
    // Not a task charge, so this deliberately does NOT advance
    // credit_attempt — refundTask skips the bump for a non-agent_task job
    // type, which is what keeps document refunds out of a task's attempt
    // count. A no-op when the task never went through the document route
    // (refundTask returns early once it sees no debit under the key).
    try {
      await refundTask(
        { tenantId: task.tenantId, taskId: task.id, chargeKey: `document:${task.id}`, jobType: 'document' },
        { pool: creditPool },
      );
    } catch (refundErr) {
      wlog('error', 'Stale-planning refund failed', { taskId: task.id, tenantId: task.tenantId, error: (refundErr as Error).message });
    }

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
  // No refund here, deliberately. Reaching awaiting_approval means planning
  // SUCCEEDED, so the document route already ran settleTask and reconciled the
  // `document:{taskId}` charge to real token usage. refundTask's settled-row
  // guard would skip every one of these, and execution — the only other thing
  // that charges — never started. Adding a call would be dead code that reads
  // like a safety net.
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

  // --- Sweep 4: Stalled file ingests (> 30 minutes) ---
  // file.ingest runs on FoundationWorkerFunction, whose SAM timeout is 300s, so
  // no ingest can still be alive after 30 minutes even allowing for SQS
  // redelivery. A row left in pending/processing past that is dead: the worker
  // crashed mid-pipeline, or the job was never enqueued at all (the confirm
  // route skips publishing when SQS_PROCESSING_QUEUE_URL is unset).
  //
  // Marked failed, not re-queued. `files` has no attempt counter, so retrying
  // automatically would loop a genuinely broken file through the pipeline every
  // five minutes forever. Recovery is the manual re-ingest control in Drive —
  // which is why those buttons were hidden behind showPipelineDetails rather
  // than deleted.
  //
  // Only files that were eligible for ingestion in the first place. ingestion_status
  // defaults to 'pending' on every row, but POST /files/:id/confirm enqueues
  // file.ingest only for pdf/docx/txt/csv — so without this filter the sweep marks
  // every image, video, audio file and avatar SVG as 'failed' half an hour after
  // upload, for a job that was never meant to run. Observed on dev: 25 of 32
  // 'failed' rows were files that had no pipeline to fail in. Kept in step with
  // isIngestibleDocument in apps/api/src/routes/files.ts.
  const ingestible = sql`(
        ${files.mimeType} IN (
          'application/pdf',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'text/plain',
          'text/csv'
        )
        OR lower(${files.name}) ~ '\\.(pdf|docx|txt|csv)$'
      )`;

  const stalledIngests = await db
    .update(files)
    .set({ ingestionStatus: 'failed', updatedAt: new Date() })
    .where(and(
      inArray(files.ingestionStatus, ['pending', 'processing']),
      sql`${files.updatedAt} < NOW() - INTERVAL '30 minutes'`,
      ingestible,
    ))
    .returning({ id: files.id, tenantId: files.tenantId, name: files.name });

  if (stalledIngests.length > 0) {
    wlog('warn', 'Stalled file ingests marked failed', {
      count: stalledIngests.length,
      fileIds: stalledIngests.map((f) => f.id),
    });

    for (const file of stalledIngests) {
      db.insert(auditLog).values({
        tenantId: file.tenantId,
        actorId: 'system',
        actorType: 'system',
        action: 'file_ingest_timed_out',
        resource: 'file',
        resourceId: file.id,
        metadata: { filename: file.name, reason: 'Ingestion exceeded 30 minutes without completing.' },
        traceId: '',
      }).catch(() => {});
    }
  }

  // --- Sweep 5: Orphaned clarification/upload requests ---
  // ask_clarifying_questions and request_upload both block the agent-orchestrator
  // tool's execute() on an in-memory Promise, resolved either by the user
  // answering or by the tool's own setTimeout (120s / 10min). Both live only in
  // a module-level Map, so a PM2 restart of agent-orchestrator (this repo's
  // deploy.sh never restarts it — CLAUDE.md — every deploy needing it needs a
  // manual `pm2 restart agent-orchestrator`) wipes the Map without ever
  // resolving the promise or updating the DB row. The message is left
  // 'pending' forever: the overlay card would render on any future reload,
  // and the agent that was blocked on it is simply gone.
  //
  // Cutoffs sit well past each tool's own timeout (120s clarification, 10min
  // upload) so this only catches requests whose *process* died — not ones a
  // live instance is still legitimately counting down on its own.
  const expiredClarifications = await db
    .update(messages)
    .set({ clarificationRequest: sql`jsonb_set(${messages.clarificationRequest}, '{status}', '"expired"')` })
    .where(and(
      sql`${messages.clarificationRequest}->>'status' = 'pending'`,
      sql`${messages.createdAt} < NOW() - INTERVAL '5 minutes'`,
    ))
    .returning({ id: messages.id, tenantId: messages.tenantId });

  if (expiredClarifications.length > 0) {
    wlog('warn', 'Orphaned clarification requests marked expired', {
      count: expiredClarifications.length,
      messageIds: expiredClarifications.map((m) => m.id),
    });
  }

  const expiredUploads = await db
    .update(messages)
    .set({ uploadRequest: sql`jsonb_set(${messages.uploadRequest}, '{status}', '"expired"')` })
    .where(and(
      sql`${messages.uploadRequest}->>'status' = 'pending'`,
      sql`${messages.createdAt} < NOW() - INTERVAL '15 minutes'`,
    ))
    .returning({ id: messages.id, tenantId: messages.tenantId });

  if (expiredUploads.length > 0) {
    wlog('warn', 'Orphaned upload requests marked expired', {
      count: expiredUploads.length,
      messageIds: expiredUploads.map((m) => m.id),
    });
  }

  // --- Sweep 6: Abandoned tool-call approvals (> 24h) ---
  // A generation tool paused for human approval (generateImage/Video/Song,
  // editImage, createSkill) suspends via Mastra's native tool-approval
  // mechanism, which — unlike the old hand-rolled confirm gate this replaced
  // — has no built-in expiry: it persists indefinitely until answered. See
  // docs/superpowers/specs/2026-09-10-mastra-native-runtime-migration-design.md
  // Design §2. chatStream.ts's SSE disconnect handler already declines the
  // *local* wait the instant a browser tab closes, so this sweep only ever
  // catches a run whose Mastra-side snapshot survived that — a PM2 restart
  // mid-wait, or a decision nobody ever made.
  //
  // The threshold is 24h, not this schedule's 5 minutes, because an open SSE
  // connection resolves the overwhelming majority of these in seconds, not
  // minutes — this sweep exists for the rare leftover, not the common case.
  //
  // Declines via the agent-orchestrator's own declineToolCall (not a direct
  // storage write) so the run's model loop actually resumes and the decline
  // lands in the thread's message history exactly like a human decline
  // would — same path as sessions.ts's POST /api/chat/generation-confirm.
  //
  // Filters on toolCall.requiresApproval, Mastra's own discriminator for an
  // approval suspension — not "suspended and old" alone. Other Mastra
  // workflow suspends (the PRD/roadmap/task workflows) persist in the exact
  // same snapshot storage for entirely unrelated reasons; sweeping by age
  // alone would cancel live workflow runs, the same shape of false positive
  // as Sweep 4's ingest incident documented above.
  const APPROVAL_EXPIRY_HOURS = 24;
  const orchestratorUrl = process.env.AGENT_ORCHESTRATOR_URL;
  const internalServiceKey = process.env.INTERNAL_SERVICE_KEY;

  if (orchestratorUrl && internalServiceKey) {
    const cutoff = new Date(Date.now() - APPROVAL_EXPIRY_HOURS * 60 * 60 * 1000);
    try {
      const res = await fetch(`${orchestratorUrl}/internal/expire-tool-approvals`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Service-Key': internalServiceKey },
        body: JSON.stringify({
          toDate: cutoff.toISOString(),
          reason: 'Expired: nobody answered this approval request in time.',
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        wlog('error', 'Expire-tool-approvals request failed', { status: res.status });
      } else {
        const body = await res.json() as { declined?: Array<{ runId: string; toolCallId?: string; error?: string }> };
        const declined = body.declined ?? [];
        const failed = declined.filter((d) => d.error);
        if (declined.length > 0) {
          wlog('info', 'Expired tool-call approvals declined', {
            count: declined.length,
            failedCount: failed.length,
            runIds: declined.map((d) => d.runId),
          });
        }
      }
    } catch (err) {
      // Non-fatal by the same convention as every sweep above — a failed
      // call here must not stop sweeps that already ran, and there is no
      // per-tenant state to roll back: nothing was written to this
      // Lambda's own database in this sweep, only a request to another
      // service.
      wlog('error', 'Expire-tool-approvals call failed', { error: (err as Error).message });
    }
  } else {
    wlog('warn', 'Expire-tool-approvals sweep skipped — missing config', {
      missing: [
        !orchestratorUrl ? 'AGENT_ORCHESTRATOR_URL' : null,
        !internalServiceKey ? 'INTERNAL_SERVICE_KEY' : null,
      ].filter((v): v is string => v !== null),
    });
  }
};
