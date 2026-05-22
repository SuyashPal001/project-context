import type { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import { route } from './router';
import { initSecrets } from './lib/initSecrets';

/**
 * Foundation Worker Lambda — SQS consumer
 *
 * Uses partial batch failure reporting — failed messages return to queue
 * for retry without blocking successfully processed messages.
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  await initSecrets();
  const failures: SQSBatchItemFailure[] = [];

  for (const record of event.Records) {
    try {
      const body = JSON.parse(record.body);

      console.log('Worker received job', {
        messageId: record.messageId,
        type: body?.type ?? 'unknown',
        tenantId: (body?.payload as Record<string, unknown>)?.tenantId ?? body?.tenantId ?? 'unknown',
      });

      await route(body);
    } catch (err) {
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
