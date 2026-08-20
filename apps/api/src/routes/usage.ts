import { Hono } from 'hono';
import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { usageRecords } from '@serverless-saas/database/schema/billing';
import { features } from '@serverless-saas/database/schema/entitlements';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '../types';

export const usageRoutes = new Hono<AppEnv>();

// GET /api/v1/usage — Returns usage data aggregated by day or month
usageRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'usage', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    // Extract query parameters
    const period = c.req.query('period') === 'monthly' ? 'monthly' : 'daily';
    const metric = c.req.query('metric') || 'api_calls';
    const startDateParam = c.req.query('startDate');
    const endDateParam = c.req.query('endDate');

    // Default to current month if no dates provided
    const now = new Date();
    const startDate = startDateParam ? new Date(startDateParam) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = endDateParam ? new Date(endDateParam) : now;

    try {
        const truncFn = period === 'monthly' ? 'month' : 'day';

        const result = await db.execute(sql`
            SELECT
                DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)::text AS date,
                SUM(quantity)::int AS value
            FROM usage_records
            WHERE tenant_id = ${tenantId}
              AND metric = ${metric}
              AND recorded_at >= ${startDate.toISOString()}
              AND recorded_at <= ${endDate.toISOString()}
            GROUP BY DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)
            ORDER BY DATE_TRUNC(${sql.raw(`'${truncFn}'`)}, recorded_at)
        `);

        const aggregatedData = result as unknown as { date: string; value: number }[];

        // Calculate total
        const total = aggregatedData.reduce((sum: number, row: { date: string, value: number }) => sum + (row.value || 0), 0);

        // Format dates to YYYY-MM-DD for easier client consumption
        const formattedData = aggregatedData.map((row: { date: string, value: number }) => ({
            date: row.date.split(' ')[0], // Extracts just the date part from "2024-03-01 00:00:00+00"
            value: row.value || 0
        }));

        // Retrieve limit from entitlements
        let limit = 0;
        const entitlementsMap = requestContext?.entitlements ?? {};
        
        // Find the feature by its metric key (assuming the feature key matches the metric)
        const feature = (await db.select().from(features).where(eq(features.key, metric)).limit(1))[0];

        if (feature) {
            const entitlement = entitlementsMap[feature.id];
            if (entitlement && !entitlement.unlimited) {
                limit = entitlement.valueLimit ?? 0;
            }
        }

        return c.json({
            data: formattedData,
            total,
            limit,
            period,
            metric
        });

    } catch (error) {
        console.error('Failed to fetch usage data:', error);
        return c.json({ error: 'Internal error fetching usage', code: 'INTERNAL_ERROR' }, 500);
    }
});

// GET /api/v1/usage/summary — Current-month totals for all metered features vs plan limits
usageRoutes.get('/summary', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const permissions = requestContext?.permissions ?? [];
    const entitlements: Record<string, { valueLimit?: number; unlimited?: boolean }> =
        requestContext?.entitlements ?? {};

    if (!hasPermission(permissions, 'usage', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const meteredFeatures = await db
        .select()
        .from(features)
        .where(eq(features.type, 'metered'));

    const summary: Record<string, {
        used: number;
        limit: number | null;
        remaining: number | null;
        percentage: number;
    }> = {};

    for (const feature of meteredFeatures) {
        if (!feature.metricKey) continue;

        const [result] = await db
            .select({ total: sql<number>`COALESCE(SUM(${usageRecords.quantity}), 0)::int` })
            .from(usageRecords)
            .where(and(
                eq(usageRecords.tenantId, tenantId),
                eq(usageRecords.metric, feature.metricKey),
                gte(usageRecords.recordedAt, startOfMonth)
            ));

        const used = result?.total ?? 0;
        const entitlement = entitlements[feature.id];

        if (entitlement?.unlimited) {
            summary[feature.metricKey] = { used, limit: null, remaining: null, percentage: 0 };
        } else {
            const limit = entitlement?.valueLimit ?? 0;
            const remaining = Math.max(0, limit - used);
            const percentage = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
            summary[feature.metricKey] = { used, limit, remaining, percentage };
        }
    }

    return c.json(summary);
});