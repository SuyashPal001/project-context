import { route } from './router';
import { initSecrets } from './lib/initSecrets';

/**
 * EventBridge Schedule entry point for the nightly subscription renewal
 * (see handlers/creditsRenew.ts for the job itself).
 *
 * Deliberately its own Lambda function, not a Schedule event bolted onto
 * FoundationWorkerFunction: that function's handler (lambda.handler) expects
 * an SQSEvent shape (`event.Records[].body` as a JSON string). An EventBridge
 * Schedule's `Input` is delivered as the raw Lambda event instead, so this
 * passes it straight to route(), which only reads `body.type` — matching the
 * `{"type":"credits.renew"}` Input configured in template.yaml.
 *
 * Separate from CreditsExpireFunction for the same reason they have different
 * timeouts: the expiry sweep's candidate set is small, this one's is every
 * active tenant.
 */
export const handler = async (event: Record<string, unknown>): Promise<void> => {
  await initSecrets();
  await route(event);
};
