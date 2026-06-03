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
      console.log(JSON.stringify({ level: 'info', message: 'idempotency_skip', messageId: record.messageId }));
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
