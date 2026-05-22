import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ensureCacheHealthy } from '@serverless-saas/cache';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });
const cache = new Map<string, string>();

async function fetchSecret(arn: string): Promise<string> {
    if (cache.has(arn)) return cache.get(arn)!;
    const resp = await client.send(new GetSecretValueCommand({ SecretId: arn }));
    const value = resp.SecretString ?? '';
    cache.set(arn, value);
    return value;
}

/**
 * Fetches UPSTASH_REDIS_TOKEN, TOKEN_ENCRYPTION_KEY, and INTERNAL_SERVICE_KEY
 * from Secrets Manager at cold start and injects them into process.env.
 * Skipped if the _SECRET_ARN env var is absent (e.g. local dev where the
 * plain value is already set directly).
 */
export async function initRuntimeSecrets(): Promise<void> {
    const upstashArn   = process.env.UPSTASH_REDIS_TOKEN_SECRET_ARN;
    const tokenKeyArn  = process.env.TOKEN_ENCRYPTION_KEY_SECRET_ARN;
    const serviceKeyArn = process.env.INTERNAL_SERVICE_KEY_SECRET_ARN;
    const githubAppArn = process.env.GITHUB_APP_SECRET_ARN;

    await Promise.all([
        upstashArn ? fetchSecret(upstashArn).then((raw) => {
            process.env.UPSTASH_REDIS_TOKEN = JSON.parse(raw).token;
        }) : Promise.resolve(),

        tokenKeyArn ? fetchSecret(tokenKeyArn).then((raw) => {
            process.env.TOKEN_ENCRYPTION_KEY = raw;
        }) : Promise.resolve(),

        serviceKeyArn ? fetchSecret(serviceKeyArn).then((raw) => {
            process.env.INTERNAL_SERVICE_KEY = JSON.parse(raw).key;
        }) : Promise.resolve(),

        githubAppArn ? fetchSecret(githubAppArn).then((raw) => {
            const parsed = JSON.parse(raw) as {
                app_id?: string; app_slug?: string;
                private_key?: string; webhook_secret?: string;
            };
            if (parsed.app_id) process.env.GITHUB_APP_ID = parsed.app_id;
            if (parsed.app_slug) process.env.GITHUB_APP_SLUG = parsed.app_slug;
            if (parsed.private_key) process.env.GITHUB_APP_PRIVATE_KEY = parsed.private_key;
            if (parsed.webhook_secret) process.env.GITHUB_WEBHOOK_SECRET = parsed.webhook_secret;
        }) : Promise.resolve(),
    ]);

    // Verify Redis connectivity after credentials are injected (L1-5)
    await ensureCacheHealthy();
}
