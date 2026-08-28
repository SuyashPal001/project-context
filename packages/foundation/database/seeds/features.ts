import { eq } from 'drizzle-orm';
import { features } from '../schema/index';
import type { db as DB } from './index';

type FeatureType = 'boolean' | 'limit' | 'metered';
type ResetPeriod = 'monthly' | 'daily' | 'weekly' | null;

const FEATURES: {
    key: string;
    name: string;
    type: FeatureType;
    description?: string | null;
    unit: string | null;
    resetPeriod: ResetPeriod;
    metricKey: string | null;
}[] = [
        { key: 'sso', name: 'Single Sign-On', type: 'boolean', unit: null, resetPeriod: null, metricKey: null },
        { key: 'agent_workflows', name: 'Agent Workflows', type: 'boolean', unit: null, resetPeriod: null, metricKey: null },
        { key: 'custom_roles', name: 'Custom Roles', type: 'boolean', unit: null, resetPeriod: null, metricKey: null },
        { key: 'mcp_integrations', name: 'MCP Integrations', type: 'boolean', unit: null, resetPeriod: null, metricKey: null },
        { key: 'audit_log', name: 'Audit Log', type: 'boolean', unit: null, resetPeriod: null, metricKey: null },
        { key: 'seats', name: 'Team Seats', type: 'limit', unit: 'seats', resetPeriod: null, metricKey: null },
        { key: 'workspaces', name: 'Workspaces', type: 'limit', unit: 'workspaces', resetPeriod: null, metricKey: null },
        { key: 'agents', name: 'AI Agents', type: 'limit', unit: 'agents', resetPeriod: null, metricKey: null },
        { key: 'integrations', name: 'Integrations', type: 'limit', unit: 'integrations', resetPeriod: null, metricKey: null },
        { key: 'api_calls', name: 'API Calls', type: 'metered', unit: 'calls', resetPeriod: 'monthly', metricKey: 'api_calls' },
        { key: 'llm_tokens', name: 'LLM Tokens', type: 'metered', unit: 'tokens', resetPeriod: 'monthly', metricKey: 'llm_tokens' },
        { key: 'storage_gb', name: 'Storage', type: 'metered', unit: 'gb', resetPeriod: null, metricKey: 'storage_gb' },
        { key: 'evals', type: 'boolean', name: 'Evals Dashboard', description: 'Access to agent quality evals and feedback analytics', unit: null, resetPeriod: null, metricKey: null },
        { key: 'branding', type: 'boolean', name: 'Custom Branding', description: 'Custom logo and workspace branding', unit: null, resetPeriod: null, metricKey: null },
        { key: 'api_keys', type: 'limit', name: 'API Keys', description: 'Maximum number of API keys per workspace', unit: 'keys', resetPeriod: null, metricKey: null },
        { key: 'webhooks', type: 'boolean', name: 'Webhooks', description: 'Webhook endpoints for event notifications', unit: null, resetPeriod: null, metricKey: null },
        { key: 'api_keys_access', type: 'boolean', name: 'API Keys Access', description: 'Programmatic API access via API keys', unit: null, resetPeriod: null, metricKey: null },
        { key: 'messages', name: 'Agent Messages', type: 'metered', description: 'Agent messages per month', unit: 'messages', resetPeriod: 'monthly', metricKey: 'messages' },
        { key: 'credits', name: 'Credits', type: 'metered', description: 'Credits per billing cycle', unit: 'credits', resetPeriod: 'monthly', metricKey: 'credits' },
    ];

export const FEATURE_KEYS = FEATURES.map((f) => f.key);

export async function seedFeatures(db: typeof DB) {
    console.log('seeding features');

    for (const f of FEATURES) {
        const existing = await db
            .select({ id: features.id })
            .from(features)
            .where(eq(features.key, f.key))
            .limit(1);

        if (existing.length > 0) {
            console.log(`  skip ${f.key}`);
            continue;
        }

        await db.insert(features).values({ ...f, status: 'active' });
        console.log(`  inserted ${f.key}`);
    }
}