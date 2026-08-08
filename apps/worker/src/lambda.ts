import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { route } from './router';
import { initSecrets } from './lib/initSecrets';
import { IdempotencyStore } from '@serverless-saas/idempotency';
import { getRedis } from './redis';

/**
 * Foundation Worker Lambda — SQS consumer
 *
 * Uses partial batch failure reporting — failed messages return to queue
 * for retry without blocking successfully processed messages.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  await initSecrets();
  const store = new IdempotencyStore(getRedis());
  const failures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    const acquired = await store.acquire(record.messageId);
    if (!acquired) {
      // Distinguish "already done" from "someone else is mid-flight". Treating
      // both as done is what silently destroyed jobs: a consumer killed without
      // a catchable error left a claim behind, and every redelivery was then
      // mistaken for a duplicate and deleted rather than retried.
      if (await store.isProcessed(record.messageId)) {
        console.log(JSON.stringify({ level: 'info', message: 'idempotency_skip_completed', messageId: record.messageId }));
        continue;
      }
      // A live claim held by another invocation. Report it as failed so SQS
      // redelivers later rather than dropping it on this consumer's behalf.
      console.log(JSON.stringify({ level: 'info', message: 'idempotency_in_flight_requeue', messageId: record.messageId }));
      failures.push({ itemIdentifier: record.messageId });
      continue;
    }

    try {
      const body = JSON.parse(record.body);

      console.log('Worker received job', {
        messageId: record.messageId,
        type: body?.type ?? 'unknown',
        tenantId: (body?.payload as Record<string, unknown>)?.tenantId ?? body?.tenantId ?? 'unknown',
      });

      await route(body);
      await store.complete(record.messageId);
    } catch (err) {
      await store.release(record.messageId);
      console.error('Worker failed to process message', {
        messageId: record.messageId,
        error: err instanceof Error ? err.message : String(err),
      });

      failures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures: failures };
};
// force rebuild 1773660778
