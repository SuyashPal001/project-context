import { handleNotification } from './handlers/notification';
import { handleStep } from './handlers/step';
import { handleEmail } from './handlers/email';
import { handleAudit } from './handlers/audit';
import { handleCacheInvalidate } from './handlers/cache';
import { handleWebhookDelivery } from './handlers/webhookDelivery';
import { handleUsageRecord } from './handlers/usageRecord';
import { handleDocumentIngest, DocumentIngestPayload } from './handlers/documentIngest';
import { handleEvalAuto } from './handlers/evalAuto';
import { handleWorkflowFire } from './handlers/workflowFire';
import { handleKnowledgeSync } from './handlers/knowledgeSync';
import { handleKnowledgeInitialIndex } from './handlers/knowledgeInitialIndex';

export async function route(body: Record<string, unknown>): Promise<void> {
  const type = body.type as string | undefined;

  switch (type) {
    case 'notification.fire':
      await handleNotification(body);
      break;
    case 'notification.step':
      await handleStep(body);
      break;
    case 'email.send':
      await handleEmail(body);
      break;
    case 'audit.write':
      await handleAudit(body);
      break;
    case 'cache.invalidate':
      await handleCacheInvalidate(body);
      break;
    case 'webhook.deliver':
      await handleWebhookDelivery(body);
      break;
    case 'usage.record':
      await handleUsageRecord(body);
      break;
    case 'document.ingest':
      await handleDocumentIngest(body.payload as DocumentIngestPayload);
      break;
    case 'eval.auto':
      await handleEvalAuto(body);
      break;
    case 'workflow.fire':
      await handleWorkflowFire(body);
      break;
    case 'knowledge.sync':
      await handleKnowledgeSync(body);
      break;
    case 'knowledge.initial_index':
      await handleKnowledgeInitialIndex(body);
      break;
    default:
      console.log('Worker received unknown job type — skipping', { type });
  }
}
