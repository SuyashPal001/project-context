import { Hono } from 'hono';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '../db';
import { conversations, messages } from '@serverless-saas/agent-schema/conversations';
import { hasPermission } from '@serverless-saas/permissions';
import type { AppEnv } from '@serverless-saas/types';

export const assetsRoutes = new Hono<AppEnv>();

type AssetType = 'video' | 'audio' | 'image' | 'markdown' | 'file' | 'prd' | 'roadmap' | 'tasks';

interface AssetDTO {
    id: string;
    type: AssetType;
    filename: string;
    mimeType?: string;
    size?: number;
    createdAt: string;
    sourceMessageId: string;
    fileId?: string;
    entityId?: string;
}

function classifyMimeType(mimeType: string, filename: string): AssetType {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'text/markdown' || filename.toLowerCase().endsWith('.md')) return 'markdown';
    return 'file';
}

function messageToAssets(message: typeof messages.$inferSelect): AssetDTO[] {
    const assets: AssetDTO[] = [];
    const createdAt = message.createdAt.toISOString();

    const attachments = message.attachments as Array<{ fileId?: string; name: string; type: string; size?: number }> | null;
    if (attachments) {
        for (const att of attachments) {
            if (!att.fileId) continue; // no downloadable reference — nothing for the gallery to open
            assets.push({
                id: att.fileId,
                type: classifyMimeType(att.type, att.name),
                filename: att.name,
                mimeType: att.type,
                size: att.size,
                createdAt,
                sourceMessageId: message.id,
                fileId: att.fileId,
            });
        }
    }

    const artifactRef = message.artifactRef as { type: 'prd' | 'roadmap' | 'tasks'; entityId: string; title: string } | null;
    if (artifactRef) {
        assets.push({
            id: artifactRef.entityId,
            type: artifactRef.type,
            filename: artifactRef.title,
            createdAt,
            sourceMessageId: message.id,
            entityId: artifactRef.entityId,
        });
    }

    return assets;
}

async function resolveConversation(conversationId: string, tenantId: string, userId: string) {
    const [conversation] = await db
        .select()
        .from(conversations)
        .where(and(
            eq(conversations.id, conversationId),
            eq(conversations.tenantId, tenantId),
            eq(conversations.userId, userId),
        ))
        .limit(1);
    return conversation ?? null;
}

// GET /conversations/:conversationId/assets — everything generated/attached in this conversation
assetsRoutes.get('/:conversationId/assets', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const userId = c.get('userId') as string | undefined;
    const permissions = requestContext?.permissions ?? [];

    if (!hasPermission(permissions, 'conversations', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }
    if (!tenantId) return c.json({ error: 'Tenant not resolved', code: 'NO_TENANT' }, 400);
    if (!userId) return c.json({ error: 'User not resolved', code: 'NO_USER' }, 400);

    const conversationId = c.req.param('conversationId');

    if (!await resolveConversation(conversationId, tenantId, userId)) {
        return c.json({ error: 'Conversation not found', code: 'NOT_FOUND' }, 404);
    }

    const rows = await db
        .select()
        .from(messages)
        .where(and(
            eq(messages.conversationId, conversationId),
            eq(messages.tenantId, tenantId),
        ))
        .orderBy(asc(messages.createdAt));

    const data = rows.flatMap(messageToAssets);

    return c.json({ data });
});
