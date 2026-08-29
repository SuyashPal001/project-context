import { handleNotification } from './handlers/notification';
import { handleStep } from './handlers/step';
import { handleEmail } from './handlers/email';
import { handleAudit } from './handlers/audit';
import { handleCacheInvalidate } from './handlers/cache';
import { handleWebhookDelivery } from './handlers/webhookDelivery';
import { handleUsageRecord } from './handlers/usageRecord';
import { handleWorkflowFire } from './handlers/workflowFire';
import { handleStoragePurge } from './handlers/storagePurge';
import { registerProductHandlers } from '@serverless-saas/agent-worker-handlers';

type Handler = (body: Record<string, unknown>) => Promise<void>;

const handlers = new Map<string, Handler>();

function registerHandler(type: string, fn: Handler): void {
  handlers.set(type, fn);
}

// Foundation handlers
registerHandler('notification.fire', handleNotification);
registerHandler('notification.step', handleStep);
registerHandler('email.send', handleEmail);
registerHandler('audit.write', handleAudit);
registerHandler('cache.invalidate', handleCacheInvalidate);
registerHandler('webhook.deliver', handleWebhookDelivery);
registerHandler('usage.record', handleUsageRecord);
registerHandler('workflow.fire', handleWorkflowFire);
registerHandler('storage.purge', handleStoragePurge);

// Product handlers (registered via product package — foundation never imports them directly)
registerProductHandlers(registerHandler);

export async function route(body: Record<string, unknown>): Promise<void> {
  const type = body.type as string | undefined;
  if (!type) {
    console.log('Worker received job without type — skipping');
    return;
  }
  const fn = handlers.get(type);
  if (!fn) {
    console.log('Worker received unknown job type — skipping', { type });
    return;
  }
  await fn(body);
}
