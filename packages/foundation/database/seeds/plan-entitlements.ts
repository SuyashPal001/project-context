import { eq } from 'drizzle-orm';
import { features, planEntitlements } from '../schema/index';
import type { db as DB } from './index';

type Plan = 'free' | 'starter' | 'business' | 'enterprise';

interface Entitlement {
    enabled?: boolean;
    valueLimit?: number;
    unlimited?: boolean;
}

const PLAN_ENTITLEMENTS: Record<Plan, Record<string, Entitlement>> = {
    free: {
        sso: { enabled: false },
        agent_workflows: { enabled: true },
        custom_roles: { enabled: false },
        mcp_integrations: { enabled: false },
        audit_log: { enabled: false },
        seats: { valueLimit: 3 },
        workspaces: { valueLimit: 1 },
        agents: { valueLimit: 1 },
        integrations: { valueLimit: 2 },
        api_calls: { valueLimit: 1_000 },
        llm_tokens: { valueLimit: 10_000 },
        storage_gb: { valueLimit: 20 },
        evals: { enabled: false },
        branding: { enabled: false },
        api_keys: { valueLimit: 2 },
        webhooks: { enabled: false },
        api_keys_access: { enabled: false },
        messages: { valueLimit: 500, unlimited: false },
    },
    starter: {
        sso: { enabled: false },
        agent_workflows: { enabled: true },
        custom_roles: { enabled: false },
        mcp_integrations: { enabled: true },
        audit_log: { enabled: false },
        seats: { valueLimit: 10 },
        workspaces: { valueLimit: 3 },
        agents: { valueLimit: 3 },
        integrations: { valueLimit: 5 },
        api_calls: { valueLimit: 10_000 },
        llm_tokens: { valueLimit: 100_000 },
        storage_gb: { valueLimit: 200 },
        evals: { enabled: false },
        branding: { enabled: true },
        api_keys: { valueLimit: 5 },
        webhooks: { enabled: true },
        api_keys_access: { enabled: true },
        messages: { valueLimit: 3000, unlimited: false },
    },
    business: {
        sso: { enabled: true },
        agent_workflows: { enabled: true },
        custom_roles: { enabled: true },
        mcp_integrations: { enabled: true },
        audit_log: { enabled: true },
        seats: { valueLimit: 50 },
        workspaces: { valueLimit: 10 },
        agents: { valueLimit: 10 },
        integrations: { valueLimit: 20 },
        api_calls: { valueLimit: 100_000 },
        llm_tokens: { valueLimit: 1_000_000 },
        storage_gb: { valueLimit: 1_000 },
        evals: { enabled: true },
        branding: { enabled: true },
        api_keys: { valueLimit: 20 },
        webhooks: { enabled: true },
        api_keys_access: { enabled: true },
        messages: { valueLimit: 15000, unlimited: false },
    },
    enterprise: {
        sso: { enabled: true },
        agent_workflows: { enabled: true },
        custom_roles: { enabled: true },
        mcp_integrations: { enabled: true },
        audit_log: { enabled: true },
        seats: { unlimited: true },
        workspaces: { unlimited: true },
        agents: { unlimited: true },
        integrations: { unlimited: true },
        api_calls: { unlimited: true },
        llm_tokens: { unlimited: true },
        storage_gb: { unlimited: true },
        evals: { enabled: true },
        branding: { enabled: true },
        api_keys: { unlimited: true },
        webhooks: { enabled: true },
        api_keys_access: { enabled: true },
        messages: { unlimited: true },
    },
};

export async function seedPlanEntitlements(db: typeof DB) {
    console.log('seeding plan-entitlements');

    for (const [plan, entitlements] of Object.entries(PLAN_ENTITLEMENTS) as [Plan, Record<string, Entitlement>][]) {
        // DELETE all existing rows for this plan — makes the seed the authoritative source of truth
        await db.delete(planEntitlements).where(eq(planEntitlements.plan, plan));

        const rows: (typeof planEntitlements.$inferInsert)[] = [];

        for (const [featureKey, values] of Object.entries(entitlements)) {
            const [feature] = await db
                .select({ id: features.id })
                .from(features)
                .where(eq(features.key, featureKey))
                .limit(1);

            if (!feature) {
                console.log(`  feature not found: ${featureKey}`);
                continue;
            }

            rows.push({
                plan,
                featureId: feature.id,
                enabled: values.enabled ?? false,
                valueLimit: values.valueLimit ?? null,
                unlimited: values.unlimited ?? false,
            });
        }

        if (rows.length > 0) {
            await db.insert(planEntitlements).values(rows);
        }

        console.log(`  ${plan}: deleted all, re-inserted ${rows.length}`);
    }
}