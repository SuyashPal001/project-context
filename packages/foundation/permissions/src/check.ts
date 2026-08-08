import type { PermissionSet, PermissionAction, PermissionString } from '@serverless-saas/types';

/**
 * Check if a permission set includes a specific resource:action pair.
 * Handles both structured PermissionSet objects and legacy "resource:action" strings.
 */
export const hasPermission = (
  permissions: PermissionSet | string[] | undefined | null,
  resource: string,
  action: PermissionAction,
): boolean => {
  if (!permissions || !Array.isArray(permissions)) return false;

  return permissions.some((p) => {
    if (!p) return false;
    if (typeof p === 'string') {
      return p === `${resource}:${action}`;
    }
    return p.resource === resource && p.action === action;
  });
};

/**
 * Narrow a set of key-scoped permission strings down to those also present
 * in the current role's permission set. Used to enforce that an API key can
 * never exceed either its own stored scope or its holder's current role.
 */
export const intersectPermissions = (
  keyPermissions: string[],
  rolePermissions: string[],
): string[] => {
  const roleSet = new Set(rolePermissions);
  const result = new Set<string>();
  for (const permission of keyPermissions) {
    if (roleSet.has(permission)) result.add(permission);
  }
  return Array.from(result);
};

/**
 * Check if a permission set includes ALL of the required permissions
 */
export const hasAllPermissions = (
  permissions: PermissionSet,
  required: Array<{ resource: string; action: PermissionAction }>,
): boolean => {
  return required.every((r) => hasPermission(permissions, r.resource, r.action));
};

/**
 * Check if a permission set includes ANY of the required permissions
 */
export const hasAnyPermission = (
  permissions: PermissionSet,
  required: Array<{ resource: string; action: PermissionAction }>,
): boolean => {
  return required.some((r) => hasPermission(permissions, r.resource, r.action));
};

/**
 * Parse a permission string "resource:action" into its parts
 */
export const parsePermissionString = (
  permission: PermissionString,
): { resource: string; action: PermissionAction } => {
  const [resource, action] = permission.split(':');
  if (!resource || !action) {
    throw new Error(`Invalid permission string: ${permission}`);
  }
  return { resource, action: action as PermissionAction };
};

/**
 * Format a resource and action into a permission string
 */
export const toPermissionString = (resource: string, action: PermissionAction): PermissionString => {
  return `${resource}:${action}` as PermissionString;
};

/**
 * Convert a PermissionSet to an array of permission strings
 */
export const toPermissionStrings = (permissions: PermissionSet): PermissionString[] => {
  return permissions.map((p) => toPermissionString(p.resource, p.action));
};

/**
 * Convert an array of permission strings to a PermissionSet
 */
export const fromPermissionStrings = (strings: PermissionString[]): PermissionSet => {
  return strings.map(parsePermissionString);
};
