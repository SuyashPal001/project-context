import { route } from './router';
import { initSecrets } from './lib/initSecrets';

/**
 * EventBridge Schedule entry point for the nightly credit expiry sweep
 * (see handlers/creditsExpire.ts for the sweep itself).
 *
 * Deliberately its own Lambda function, not a Schedule event bolted onto
 * FoundationWorkerFunction: that function's handler (lambda.handler) expects
 * an SQSEvent shape (`event.Records[].body` as a JSON string). An EventBridge
 * Schedule's `Input` is delivered as the raw Lambda event instead, so this
 * passes it straight to route(), which only reads `body.type` — matching the
 * `{"type":"credits.expire"}` Input configured in template.yaml.
 */
export const handler = async (event: Record<string, unknown>): Promise<void> => {
  await initSecrets();
  await route(event);
};
