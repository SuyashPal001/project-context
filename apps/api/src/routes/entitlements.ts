import { Hono } from 'hono';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { features } from '@serverless-saas/database/schema/entitlements';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { agents } from '@serverless-saas/agent-schema/agents';
import { integrations } from '@serverless-saas/database/schema/integrations';
import { usageRecords } from '@serverless-saas/database/schema/billing';
import type { AppEnv } from '../types';

export const entitlementsRoutes = new Hono<AppEnv>();

// GET /entitlements — returns plan entitlements for the tenant's current plan
// No permission check — all authenticated users can read their own entitlements
entitlementsRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;

    try {
        // Entitlements are already loaded and cached by entitlementsMiddleware
        // Format: { featureId: { enabled, valueLimit, unlimited }, ... }
        const entitlementsMap = requestContext?.entitlements ?? {};

        // Step 1: Query features table to get all feature IDs and map them to keys
        const featureIds = Object.keys(entitlementsMap);

        if (featureIds.length === 0) {
            // No entitlements configured — return empty structure
            // features: {} must be present so layout.tsx doesn't get undefined
            return c.json({
                features: {},
                seats: { used: 0, limit: 0, unlimited: false },
                api_calls: { used: 0, limit: 0, unlimited: false },
                agents: { used: 0, limit: 0, unlimited: false },
            });
        }

        const featureRows = await db.select().from(features).where(inArray(features.id, featureIds));

        // Build map: key → entitlement data
        const entitlementsByKey: Record<string, any> = {};
        for (const feature of featureRows) {
            const entitlement = entitlementsMap[feature.id];
            if (entitlement) {
                entitlementsByKey[feature.key] = {
                    enabled: entitlement.enabled,
                    valueLimit: entitlement.valueLimit,
                    unlimited: entitlement.unlimited,
                };
            }
        }

        // Step 2: Count usage for each feature

        // Seats: COUNT memberships WHERE tenantId AND status = 'active' AND memberType = 'human'
        const [seatsCount] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(memberships)
            .where(and(
                eq(memberships.tenantId, tenantId),
                eq(memberships.status, 'active'),
                eq(memberships.memberType, 'human')
            ));

        // Agents: COUNT agents WHERE tenantId AND status = 'active'
        const [agentsCount] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(agents)
            .where(and(
                eq(agents.tenantId, tenantId),
                eq(agents.status, 'active')
            ));

        // Integrations: COUNT integrations WHERE tenantId AND status = 'active'
        const [integrationsCount] = await db
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(integrations)
            .where(and(
                eq(integrations.tenantId, tenantId),
                eq(integrations.status, 'active')
            ));

        // API calls: SUM usage_records WHERE tenantId AND metric = 'api_calls' AND recordedAt within current month
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

        const [apiCallsSum] = await db
            .select({ total: sql<string>`COALESCE(SUM(${usageRecords.quantity}), 0)` })
            .from(usageRecords)
            .where(and(
                eq(usageRecords.tenantId, tenantId),
                eq(usageRecords.metric, 'api_calls'),
                gte(usageRecords.recordedAt, monthStart)
            ));

        const [messagesSum] = await db
            .select({ total: sql<string>`COALESCE(SUM(${usageRecords.quantity}), 0)` })
            .from(usageRecords)
            .where(and(
                eq(usageRecords.tenantId, tenantId),
                eq(usageRecords.metric, 'messages'),
                gte(usageRecords.recordedAt, monthStart)
            ));

        // Step 3: Build response object with exact shape
        const seatsEntitlement         = entitlementsByKey['seats']         || { enabled: false, valueLimit: 0, unlimited: false };
        const apiCallsEntitlement      = entitlementsByKey['api_calls']     || { enabled: false, valueLimit: 0, unlimited: false };
        const agentsEntitlement        = entitlementsByKey['agents']        || { enabled: false, valueLimit: 0, unlimited: false };
        const integrationsEntitlement  = entitlementsByKey['integrations']  || { enabled: false, valueLimit: 0, unlimited: false };
        const messagesEntitlement      = entitlementsByKey['messages']      || { enabled: false, valueLimit: 0, unlimited: false };

        // Collect boolean feature flags keyed by feature.key (e.g. multi_llm_claude: true/false)
        const featureFlags: Record<string, boolean> = {};
        for (const feature of featureRows) {
            if (feature.type === 'boolean') {
                featureFlags[feature.key] = entitlementsByKey[feature.key]?.enabled ?? false;
            }
        }

        return c.json({
            seats: {
                used: seatsCount?.count ?? 0,
                limit: seatsEntitlement.valueLimit ?? 0,
                unlimited: seatsEntitlement.unlimited ?? false,
            },
            api_calls: {
                used: parseInt(apiCallsSum?.total ?? '0', 10),
                limit: apiCallsEntitlement.valueLimit ?? 0,
                unlimited: apiCallsEntitlement.unlimited ?? false,
            },
            agents: {
                used: agentsCount?.count ?? 0,
                limit: agentsEntitlement.valueLimit ?? 0,
                unlimited: agentsEntitlement.unlimited ?? false,
            },
            integrations: {
                used: integrationsCount?.count ?? 0,
                limit: integrationsEntitlement.valueLimit ?? 0,
                unlimited: integrationsEntitlement.unlimited ?? false,
            },
            messages: {
                used: parseInt(messagesSum?.total ?? '0', 10),
                limit: messagesEntitlement.valueLimit ?? 0,
                unlimited: messagesEntitlement.unlimited ?? false,
            },
            features: featureFlags,
        });
    } catch (err: any) {
        console.error('Get entitlements error:', err);
        const code = err.name || 'INTERNAL_ERROR';
        const message = err.message || 'Failed to fetch entitlements';
        return c.json({ error: message, code }, 500);
    }
});
