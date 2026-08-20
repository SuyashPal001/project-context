import { eq, and } from 'drizzle-orm';
import { permissions } from '../schema/index';
import type { db as DB } from './index';

type Action = 'create' | 'read' | 'update' | 'delete';

export const RESOURCES: Record<string, Action[]> = {
    members: ['create', 'read', 'update', 'delete'],
    invitations: ['create', 'read', 'delete'],
    roles: ['create', 'read', 'update', 'delete'],
    skills: ['create', 'read', 'update', 'delete'],
    billing: ['read', 'update'],
    invoices: ['read'],
    subscriptions: ['create', 'read', 'update', 'delete'],
    api_keys: ['create', 'read', 'update', 'delete'],
    agents: ['create', 'read', 'update', 'delete'],
    agent_tasks: ['create', 'read', 'update', 'delete'],
    agent_workflows: ['create', 'read', 'update', 'delete'],
    agent_runs: ['read', 'delete'],
    notifications: ['create', 'read', 'update', 'delete'],
    audit_log: ['read'],
    tenant: ['read', 'update', 'delete'],
    entitlements: ['create', 'read', 'update', 'delete'],
    integrations: ['create', 'read', 'update', 'delete'],
    usage: ['read'],
    webhooks: ['create', 'read', 'update', 'delete'],
    files: ['create', 'read', 'delete'],
    conversations: ['create', 'read', 'update', 'delete'],
    messages: ['create', 'read'],
    analytics: ['read'],
    project_plans: ['create', 'read', 'update', 'delete'],
    project_milestones: ['create', 'read', 'update', 'delete'],
    project_pages: ['create', 'read', 'update', 'delete'],
    handover_packs: ['create', 'read', 'update', 'delete'],
};

export async function seedPermissions(db: typeof DB) {
    console.log('seeding permissions');

    let created = 0;
    let skipped = 0;

    for (const [resource, actions] of Object.entries(RESOURCES)) {
        for (const action of actions) {
            const existing = await db
                .select({ id: permissions.id })
                .from(permissions)
                .where(and(eq(permissions.resource, resource), eq(permissions.action, action)))
                .limit(1);

            if (existing.length > 0) {
                skipped++;
                continue;
            }

            await db.insert(permissions).values({ resource, action });
            created++;
        }
    }

    console.log(`  inserted ${created}, skipped ${skipped}`);
}