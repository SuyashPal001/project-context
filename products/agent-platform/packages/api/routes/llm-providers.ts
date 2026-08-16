import { Hono } from 'hono';
import { and, eq, desc, asc, inArray } from 'drizzle-orm';
import { db } from '@serverless-saas/database/client';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import type { AppEnv } from '@serverless-saas/types';

export const llmProvidersRoutes = new Hono<AppEnv>();

// GET /llm-providers — List platform LLM providers for model selector
llmProvidersRoutes.get('/', async (c) => {
    const data = await db
        .select({
            id: llmProviders.id,
            provider: llmProviders.provider,
            model: llmProviders.model,
            displayName: llmProviders.displayName,
            isDefault: llmProviders.isDefault,
            status: llmProviders.status,
            costPerToken: llmProviders.costPerToken,
        })
        .from(llmProviders)
        .where(and(eq(llmProviders.isPlatform, true), inArray(llmProviders.status, ['live', 'coming_soon'])))
        .orderBy(desc(llmProviders.isDefault), asc(llmProviders.displayName));

    return c.json({
        providers: data.map((row: any) => ({
            id: row.id,
            provider: row.provider,
            model: row.model,
            displayName: row.displayName ?? row.model,
            isDefault: row.isDefault,
            status: row.status as 'live' | 'coming_soon',
            costPerToken: row.costPerToken as string | null,
        })),
    });
});
