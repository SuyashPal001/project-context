import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppEnv } from '@serverless-saas/types';
import { db } from '../db';
import { personas } from '@serverless-saas/agent-schema/personas';
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
    const data = await db
        .select({
            id: personas.id, slug: personas.slug, name: personas.name, tagline: personas.tagline,
            skillTags: personas.skillTags, isOfficial: personas.isOfficial,
            exampleAssetUrl: personas.exampleAssetUrl, exampleCaption: personas.exampleCaption,
            exampleAssetUrl2: personas.exampleAssetUrl2, exampleCaption2: personas.exampleCaption2,
        })
        .from(personas)
        .where(eq(personas.status, 'published'));
    return c.json({ personas: data });
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
