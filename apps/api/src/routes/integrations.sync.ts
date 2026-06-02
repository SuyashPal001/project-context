import { and, eq } from 'drizzle-orm';
import { db } from '@serverless-saas/database';
import { agents } from '@serverless-saas/agent-schema/agents';
import { agentSkills } from '@serverless-saas/agent-schema/conversations';
import { PROVIDER_TOOLS_MAP } from './integrations.crypto';

// Merges provider tools into agent_skills.tools and fires relay /update.
// Non-throwing — logs errors but does not block the calling handler.
export async function syncToolsAndNotifyRelay(tenantId: string, provider: string, action: 'add' | 'remove'): Promise<void> {
    const providerTools = PROVIDER_TOOLS_MAP[provider];
    if (!providerTools?.length) return;

    try {
        const [agent] = await db
            .select({ id: agents.id })
            .from(agents)
            .where(and(eq(agents.tenantId, tenantId), eq(agents.status, 'active')))
            .limit(1);
        if (!agent) return;

        const [skill] = await db
            .select({ id: agentSkills.id, tools: agentSkills.tools })
            .from(agentSkills)
            .where(and(eq(agentSkills.agentId, agent.id), eq(agentSkills.tenantId, tenantId), eq(agentSkills.status, 'active')))
            .limit(1);
        if (!skill) return;

        const current = skill.tools ?? [];
        const updated = action === 'add'
            ? [...new Set([...current, ...providerTools])]
            : current.filter((t: string) => !providerTools.includes(t));

        await db.update(agentSkills)
            .set({ tools: updated, updatedAt: new Date() })
            .where(eq(agentSkills.id, skill.id));

        const relayUrl = process.env.AGENT_ORCHESTRATOR_URL;
        if (relayUrl) {
            fetch(`${relayUrl}/update/${tenantId}/${agent.id}`, {
                method: 'POST',
                headers: { 'x-service-key': process.env.INTERNAL_SERVICE_KEY!, 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            }).catch((e: Error) => console.warn('[relay update failed]', e.message));
        }
    } catch (err) {
        console.error(`[syncToolsAndNotifyRelay] provider=${provider} action=${action}:`, (err as Error).message);
    }
}
