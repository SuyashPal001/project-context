export interface Entitlement {
  valueLimit?: number | null;
  unlimited?: boolean | null;
}

export type EntitlementMap = Record<string, Entitlement>;

export interface WorkspaceLimit {
  unlimited: boolean;
  limit: number;
}

/**
 * Resolve how many workspaces a tenant may own.
 *
 * An absent entitlement map means entitlementsMiddleware did not run for this
 * request — a wiring error, not a free-tier user. Defaulting to 1 there is what
 * silently capped every paid plan at a single workspace and told customers who
 * had already upgraded to upgrade. Fail loudly instead: a 500 surfaces on the
 * first request, where a wrong-but-plausible limit never surfaces at all.
 *
 * A map that is present but simply lacks the feature is a real answer — that
 * plan does not grant workspaces — so the conservative 1 applies there.
 */
export function resolveWorkspaceLimit(
  entitlements: EntitlementMap | undefined,
  featureId: string,
): WorkspaceLimit {
  if (!entitlements) {
    throw new Error(
      'entitlements missing from request context — the workspace limit cannot be resolved. ' +
        'This route must be registered after entitlementsMiddleware in app.ts.',
    );
  }

  const entitlement = entitlements[featureId];
  return {
    unlimited: entitlement?.unlimited ?? false,
    limit: entitlement?.valueLimit ?? 1,
  };
}
