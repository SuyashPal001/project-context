import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppEnv } from '@serverless-saas/types';
import { db } from '../db';
import { personas } from '@serverless-saas/agent-schema/personas';
import { llmProviders } from '@serverless-saas/database/schema/integrations';
import { handleEnsureReady, handleAgentStatus } from './agents.health';
import { handleListAgents, handleGetAgent, handleCreateAgent, handleUpdateAgent, handleDeleteAgent } from './agents.crud';
import { agentFairnessRoutes } from './agents.fairness';
import { agentMemoryRoutes } from './agent-memory';
import { agentCoreFilesRoutes } from './agent-core-files';

export const agentsRoutes = new Hono<AppEnv>();

// Health / readiness (before parameterized routes)
agentsRoutes.get('/ensure-ready', handleEnsureReady);
agentsRoutes.get('/:id/status', handleAgentStatus);

// GET /agents/personas — published personas only, any authenticated tenant member
agentsRoutes.get('/personas', async (c) => {
    // Personas don't carry their own model — the model is chosen when an agent is
    // hired from one. This is the platform default every new hire gets today, shown
    // as "Mind" on the persona card so it isn't fabricated in the frontend.
    const [defaultProvider] = await db
        .select({ displayName: llmProviders.displayName })
        .from(llmProviders)
        .where(and(eq(llmProviders.isPlatform, true), eq(llmProviders.isDefault, true)))
        .limit(1);

    const data = await db
        .select({
            id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
            category: personas.category, skillTags: personas.skillTags, isOfficial: personas.isOfficial,
            exampleAssetUrl: personas.exampleAssetUrl, exampleCaption: personas.exampleCaption,
            exampleAssetUrl2: personas.exampleAssetUrl2, exampleCaption2: personas.exampleCaption2,
        })
        .from(personas)
        .where(eq(personas.status, 'published'));

    const defaultModel = defaultProvider?.displayName ?? null;
    return c.json({ personas: data.map((p) => ({ ...p, defaultModel })) });
});

// CRUD
agentsRoutes.get('/', handleListAgents);
agentsRoutes.get('/:id', handleGetAgent);
agentsRoutes.post('/', handleCreateAgent);
agentsRoutes.patch('/:id', handleUpdateAgent);
agentsRoutes.delete('/:id', handleDeleteAgent);

// Fairness
agentsRoutes.route('/', agentFairnessRoutes);

// Memory (MEMORY.md — tenant-editable Core Files tab)
agentsRoutes.route('/', agentMemoryRoutes);

// Core Files (locked file list — content never leaves the server)
agentsRoutes.route('/', agentCoreFilesRoutes);
