import { and, eq } from 'drizzle-orm';
import type { DB } from '@serverless-saas/database';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { rolePermissions, permissions } from '@serverless-saas/database/schema/authorization';

// Load membership to get the user's roleId for this tenant, then join
// role_permissions → permissions to get the full permission set for that role.
// No caching here — caching is Redis/request-lifecycle-specific and stays in
// whichever caller needs it (see apps/api/src/middleware/permissions.ts).
export async function resolveUserPermissions(
  db: DB,
  tenantId: string,
  userId: string,
): Promise<{ resource: string; action: string }[] | null> {
  const [membership] = await db.select().from(memberships).where(
    and(
      eq(memberships.userId, userId),
      eq(memberships.tenantId, tenantId),
      eq(memberships.status, 'active'),
    ),
  ).limit(1);

  // No membership = no permission set to resolve. Callers decide what that means.
  if (!membership) return null;

  const permissionRows = await db
    .select({ resource: permissions.resource, action: permissions.action })
    .from(rolePermissions)
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(rolePermissions.roleId, membership.roleId));

  return permissionRows.map((p: { resource: string; action: string }) => ({
    resource: p.resource,
    action: p.action,
  }));
}
