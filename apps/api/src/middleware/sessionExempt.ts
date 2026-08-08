/**
 * Routes exempt from session-blacklist validation.
 *
 * These two must stay reachable with a token whose session has been
 * invalidated, so the client can still resolve "who am I" and "which workspaces
 * do I belong to" while recovering from logout or a workspace switch.
 *
 * Paths are written with the /api/v1 mount prefix on purpose. The previous
 * implementation passed bare paths to Hono's `except`, which matches against
 * `c.req.path` — the full request path — so the exemption never matched and
 * silently did nothing. Writing the full path and testing the predicate makes
 * that class of mistake visible instead of invisible.
 */
export const SESSION_EXEMPT_PATHS = [
  '/api/v1/auth/me',
  '/api/v1/auth/tenants',
] as const;

export function isSessionValidationExempt(requestPath: string): boolean {
  // Drop any query string, then any single trailing slash.
  const path = requestPath.split('?')[0].replace(/\/+$/, '');
  return SESSION_EXEMPT_PATHS.some((exempt) => path === exempt);
}
