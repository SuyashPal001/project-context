import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });
let loaded = false;

export async function initSecrets(): Promise<void> {
    if (loaded) return;
    loaded = true;

    const githubAppArn = process.env.GITHUB_APP_SECRET_ARN;
    if (!githubAppArn) return;

    const resp = await client.send(new GetSecretValueCommand({ SecretId: githubAppArn }));
    const raw = resp.SecretString ?? '';
    if (!raw) return;

    const parsed = JSON.parse(raw) as {
        app_id?: string; app_slug?: string;
        private_key?: string; webhook_secret?: string;
    };
    if (parsed.app_id) process.env.GITHUB_APP_ID = parsed.app_id;
    if (parsed.app_slug) process.env.GITHUB_APP_SLUG = parsed.app_slug;
    if (parsed.private_key) process.env.GITHUB_APP_PRIVATE_KEY = parsed.private_key;
    if (parsed.webhook_secret) process.env.GITHUB_WEBHOOK_SECRET = parsed.webhook_secret;
}
