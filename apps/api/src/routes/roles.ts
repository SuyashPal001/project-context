import { Hono } from 'hono';
import { eq, isNull, or, and, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db, features } from '@serverless-saas/database';
import { roles, permissions, rolePermissions } from '@serverless-saas/database/schema/authorization';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { hasPermission } from '@serverless-saas/permissions';
import { logWithDiff } from '@serverless-saas/agent-api/services/audit-log';
import type { AppEnv } from '../types';

export const rolesRoutes = new Hono<AppEnv>();

// GET /roles — list system roles + tenant custom roles
rolesRoutes.get('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db.select().from(roles).where(or(
        isNull(roles.tenantId),
        eq(roles.tenantId, tenantId)
    ));

    return c.json({ roles: data });
});

// GET /roles/permissions/all — list all available permissions
rolesRoutes.get('/permissions/all', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const data = await db.select().from(permissions);
    return c.json({ data });
});

// GET /roles/:id — get a role with its permissions
rolesRoutes.get('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'read')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const roleId = c.req.param('id');
    const [role] = await db.select().from(roles).where(
        and(eq(roles.id, roleId), or(isNull(roles.tenantId), eq(roles.tenantId, tenantId)))
    ).limit(1);

    if (!role) return c.json({ error: 'Role not found' }, 404);

    const rolePerms = await db
        .select({ id: permissions.id, resource: permissions.resource, action: permissions.action, description: permissions.description })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, roleId));

    return c.json({ data: { ...role, permissions: rolePerms } });
});

// POST /roles — create a custom role (requires custom_roles entitlement)
rolesRoutes.post('/', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];
    const entitlements = requestContext?.entitlements ?? {};

    if (!hasPermission(perms, 'roles', 'create')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const feature = (await db.select().from(features).where(eq(features.key, 'custom_roles')).limit(1))[0];
    if (!feature) return c.json({ error: 'Feature configuration missing', code: 'FEATURE_NOT_FOUND' }, 500);

    if (!entitlements[feature.id]?.enabled) {
        return c.json({ error: 'Custom roles require a Business plan or above', code: 'FEATURE_NOT_AVAILABLE' }, 403);
    }

    const schema = z.object({
        name: z.string().min(1).max(50),
        description: z.string().max(255).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const [role] = await db.insert(roles).values({
        tenantId,
        name: result.data.name,
        description: result.data.description,
        isDefault: false,
        isAgentRole: false,
    }).returning();

    await logWithDiff({
        tenantId, actorId: requestContext?.userId ?? 'system', actorType: 'human',
        action: 'role_created', resource: 'role', resourceId: role.id,
        newState: { name: role.name, description: role.description },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
    }).catch(err => console.error('Audit log write failed:', err));

    return c.json({ data: role }, 201);
});

// PATCH /roles/:id — update name/description
rolesRoutes.patch('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const roleId = c.req.param('id');
    const [existing] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!existing) return c.json({ error: 'Role not found' }, 404);
    if (existing.tenantId !== tenantId) {
        return c.json({ error: 'Cannot modify a system role', code: 'SYSTEM_ROLE_IMMUTABLE' }, 403);
    }

    const schema = z.object({
        name: z.string().min(1).max(50).optional(),
        description: z.string().max(255).optional(),
    });

    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const [updated] = await db.update(roles)
        .set({ ...result.data, updatedAt: new Date() })
        .where(eq(roles.id, roleId))
        .returning();

    await logWithDiff({
        tenantId, actorId: requestContext?.userId ?? 'system', actorType: 'human',
        action: 'role_updated', resource: 'role', resourceId: updated.id,
        previousState: { name: existing.name, description: existing.description },
        newState: { name: updated.name, description: updated.description },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
    }).catch(err => console.error('Audit log write failed:', err));

    return c.json({ data: updated });
});

// POST /roles/:id/permissions — assign permissions to role
rolesRoutes.post('/:id/permissions', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const roleId = c.req.param('id');
    const [role] = await db.select().from(roles).where(
        and(eq(roles.id, roleId), eq(roles.tenantId, tenantId))
    ).limit(1);
    if (!role) return c.json({ error: 'Role not found or not editable' }, 404);

    const schema = z.object({ permissionIds: z.array(z.string().uuid()).min(1) });
    const result = schema.safeParse(await c.req.json());
    if (!result.success) return c.json({ error: result.error.errors[0].message }, 400);

    const validPerms = await db.select({ id: permissions.id }).from(permissions)
        .where(inArray(permissions.id, result.data.permissionIds));
    if (validPerms.length !== result.data.permissionIds.length) {
        return c.json({ error: 'One or more permission IDs not found' }, 400);
    }

    await db.insert(rolePermissions)
        .values(result.data.permissionIds.map(pid => ({ roleId, permissionId: pid })))
        .onConflictDoNothing();

    await logWithDiff({
        tenantId, actorId: requestContext?.userId ?? 'system', actorType: 'human',
        action: 'role_permissions_assigned', resource: 'role', resourceId: roleId,
        newState: { permissionIds: result.data.permissionIds },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
    }).catch(err => console.error('Audit log write failed:', err));

    return c.json({ success: true });
});

// DELETE /roles/:id/permissions/:permId — revoke a permission from role
rolesRoutes.delete('/:id/permissions/:permId', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'update')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const roleId = c.req.param('id');
    const permId = c.req.param('permId');

    const [role] = await db.select().from(roles).where(
        and(eq(roles.id, roleId), eq(roles.tenantId, tenantId))
    ).limit(1);
    if (!role) return c.json({ error: 'Role not found or not editable' }, 404);

    await db.delete(rolePermissions).where(
        and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.permissionId, permId))
    );

    await logWithDiff({
        tenantId, actorId: requestContext?.userId ?? 'system', actorType: 'human',
        action: 'role_permission_revoked', resource: 'role', resourceId: roleId,
        previousState: { permissionId: permId },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
    }).catch(err => console.error('Audit log write failed:', err));

    return c.json({ success: true });
});

// DELETE /roles/:id — delete a custom role
rolesRoutes.delete('/:id', async (c) => {
    const requestContext = c.get('requestContext') as any;
    const tenantId = requestContext?.tenant?.id;
    const perms = requestContext?.permissions ?? [];

    if (!hasPermission(perms, 'roles', 'delete')) {
        return c.json({ error: 'Forbidden', code: 'INSUFFICIENT_PERMISSIONS' }, 403);
    }

    const roleId = c.req.param('id');
    const [existing] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!existing) return c.json({ error: 'Role not found' }, 404);
    if (existing.tenantId !== tenantId) {
        return c.json({ error: 'Cannot delete a system role', code: 'SYSTEM_ROLE_IMMUTABLE' }, 403);
    }

    const activeMemberships = await db.select().from(memberships).where(
        and(eq(memberships.roleId, roleId), eq(memberships.status, 'active'))
    );
    if (activeMemberships.length > 0) {
        return c.json({ error: 'Cannot delete a role with active members. Reassign members first.', code: 'ROLE_HAS_ACTIVE_MEMBERS' }, 409);
    }

    await db.delete(roles).where(eq(roles.id, roleId));

    await logWithDiff({
        tenantId, actorId: requestContext?.userId ?? 'system', actorType: 'human',
        action: 'role_deleted', resource: 'role', resourceId: roleId,
        previousState: { name: existing.name, description: existing.description },
        traceId: c.get('traceId') ?? '',
        ipAddress: c.get('clientIp'),
    }).catch(err => console.error('Audit log write failed:', err));

    return c.json({ success: true });
});
