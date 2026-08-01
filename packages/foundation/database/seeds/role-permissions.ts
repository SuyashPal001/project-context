import { eq, and, isNull } from 'drizzle-orm';
import { roles, permissions, rolePermissions } from '../schema/index';
import { RESOURCES } from './permissions';
import type { db as DB } from './index';

const ALL_PERMS = Object.entries(RESOURCES).flatMap(
    ([res, actions]) => actions.map((a) => `${res}:${a}`)
);

const ROLE_PERMISSIONS: Record<string, string[]> = {
    owner: ALL_PERMS,

    admin: ALL_PERMS.filter(
        (p) =>
            p !== 'tenant:delete' &&
            p !== 'entitlements:create' &&
            p !== 'entitlements:update' &&
            p !== 'entitlements:delete'
    ),

    member: [
        'members:read',
        'roles:read',
        'notifications:read',
        'notifications:update',
        'tenant:read',
        'usage:read',
        'webhooks:read',
        'agents:read',
        'files:read',
        'files:create',
        'files:delete',
        'conversations:create',
        'conversations:read',
        'conversations:update',
        'conversations:delete',
        'messages:create',
        'messages:read',
        'agent_tasks:create',
        'agent_tasks:read',
        'agent_tasks:update',
        'project_plans:create',
        'project_plans:read',
        'project_plans:update',
        'project_plans:delete',
        'project_milestones:create',
        'project_milestones:read',
        'project_milestones:update',
        'project_milestones:delete',
        'project_pages:create',
        'project_pages:read',
        'project_pages:update',
        'project_pages:delete',
        'handover_packs:read',
        'handover_packs:update',
    ],

    'ops-agent': [
        'members:read',
        'roles:read',
        'billing:read',
        'invoices:read',
        'subscriptions:read',
        'api_keys:read',
        'agents:read',
        'agent_workflows:read',
        'agent_workflows:create',
        'agent_runs:read',
        'agent_runs:delete',
        'audit_log:read',
        'tenant:read',
        'notifications:read',
        'integrations:read',
        'usage:read',
    ],

    'custom-agent': [
        'members:read',
        'roles:read',
        'billing:read',
        'invoices:read',
        'subscriptions:read',
        'api_keys:read',
        'agents:read',
        'agent_workflows:read',
        'agent_workflows:create',
        'agent_runs:read',
        'agent_runs:delete',
        'audit_log:read',
        'tenant:read',
        'notifications:read',
        'integrations:read',
        'usage:read',
    ],

    // platform_admin has no tenant — access is gated by isPlatformAdmin() JWT check,
    // not by this permissions table. ALL_PERMS here is for future use / consistency.
    platform_admin: ALL_PERMS,
};

export async function seedRolePermissions(db: typeof DB) {
    console.log('seeding role-permissions');

    for (const [roleName, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
        const [role] = await db
            .select({ id: roles.id })
            .from(roles)
            .where(and(eq(roles.name, roleName), isNull(roles.tenantId)))
            .limit(1);

        if (!role) {
            console.log(`  role not found: ${roleName}`);
            continue;
        }

        // DELETE all existing assignments for this role first — makes the seed
        // the authoritative source of truth
        await db.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));

        // Resolve permission IDs for every key in the list
        const rows: { roleId: string; permissionId: string }[] = [];
        for (const key of permKeys) {
            const [resource, action] = key.split(':');

            const [perm] = await db
                .select({ id: permissions.id })
                .from(permissions)
                .where(and(eq(permissions.resource, resource), eq(permissions.action, action as any)))
                .limit(1);

            if (!perm) {
                console.log(`  permission not found: ${key}`);
                continue;
            }
            rows.push({ roleId: role.id, permissionId: perm.id });
        }

        if (rows.length > 0) {
            await db.insert(rolePermissions).values(rows);
        }

        console.log(`  ${roleName}: deleted all, re-inserted ${rows.length}`);
    }
}