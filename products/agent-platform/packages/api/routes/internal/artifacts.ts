import { z } from 'zod';
import { publishToQueue } from '@serverless-saas/queue';
import { isAuthorized } from './tasks.auth';
import type { Context } from 'hono';
import type { AppEnv } from '@serverless-saas/types';

const ARTIFACT_MESSAGE_TYPES: Record<string, string> = {
    prd: 'prd.created',
    roadmap: 'roadmap.created',
    tasks: 'tasks.created',
};

// POST /internal/artifacts/notify
// Called by relay after savePRD/savePlan/saveTasks completes.
// Fires an in-app notification to the user who triggered the conversation.
export async function handleArtifactNotify(c: Context<AppEnv>) {
    if (!isAuthorized(c.req.header('x-internal-service-key') ?? ''))
        return c.json({ error: 'Unauthorized' }, 401);

    const schema = z.object({
        tenantId: z.string().uuid(),
        userId: z.string().uuid(),
        artifactType: z.enum(['prd', 'roadmap', 'tasks']),
        entityId: z.string(),
        title: z.string(),
    });

    const parsed = schema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.errors[0].message }, 400);

    const { tenantId, userId, artifactType, entityId, title } = parsed.data;
    const messageType = ARTIFACT_MESSAGE_TYPES[artifactType];
    const sqsUrl = process.env.SQS_PROCESSING_QUEUE_URL;

    if (sqsUrl) {
        try {
            await publishToQueue(sqsUrl, {
                type: 'notification.fire',
                tenantId,
                messageType,
                actorId: 'system',
                actorType: 'agent',
                recipientIds: [userId],
                data: { artifactType, entityId, artifactTitle: title },
            });
        } catch (err) {
            console.error(`[artifact/${messageType}] notification publish failed (non-fatal):`, (err as Error).message);
        }
    }

    return c.json({ ok: true });
}
