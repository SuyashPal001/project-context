import type {
  PreTokenGenerationTriggerEvent,
  PreTokenGenerationTriggerHandler,
} from 'aws-lambda';

import { db } from '@serverless-saas/database';
import { users } from '@serverless-saas/database/schema/auth';
import { memberships } from '@serverless-saas/database/schema/tenancy';
import { roles } from '@serverless-saas/database/schema/authorization';
import { subscriptions } from '@serverless-saas/database/schema/billing';
import { eq, and, inArray, desc } from 'drizzle-orm';

/**
 * Cognito Pre Token Generation Lambda
 *
 * Fires synchronously on every login — email/password, Google OAuth, invite flow.
 * Must complete within 5s or Cognito will fail the login.
 *
 * Job: stamp three custom claims into the JWT:
 *   custom:tenantId → which tenant this user belongs to
 *   custom:role     → their role within that tenant
 *   custom:plan     → the tenant's current subscription plan
 *
 * Empty claims are stamped when:
 *   - User exists in Cognito but not in our DB yet (race condition, rare)
 *   - User has no active membership (brand new user, needs onboarding)
 *   - Tenant has no active subscription (should not happen, but handled safely)
 *
 * Empty tenantId is the signal to the frontend to redirect to /onboarding.
 * See ADR-026 for full reasoning.
 */
export const handler: PreTokenGenerationTriggerHandler = async (
  event: PreTokenGenerationTriggerEvent
) => {
  // Always use the Cognito sub (UUID) — event.userName for email/password users
  // may be the raw email string, which won't match cognitoId in our DB.
  // event.request.userAttributes.sub is always the stable UUID.
  const cognitoId = event.request.userAttributes.sub;
  console.log('[pretoken] step=start', { cognitoId, userName: event.userName });

  // Platform admins have no tenant — they live in the ops portal only.
  // Detect them by email before any DB lookup so the check works even before
  // userUpsertMiddleware has created their platform DB row on first API call.
  const emailFromEvent = event.request.userAttributes.email;
  const adminEmails = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',').map(e => e.trim()).filter(Boolean);
  if (emailFromEvent && adminEmails.includes(emailFromEvent)) {
    console.log('[pretoken] platform_admin detected', { email: emailFromEvent });
    return platformAdminClaimsResponse(event);
  }

  // Step 1 — find user in our DB by cognitoId
  // User is created here via middleware upsert on first API call (Volca pattern, ADR-024)
  // If not found yet, stamp empty claims — do not throw
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.cognitoId, cognitoId))
    .limit(1);

  // Fallback: look up by verified email when cognitoId doesn't match.
  // Handles first-time Google OAuth login for a user who previously signed up
  // via email/password — Cognito issues a different sub for the federated identity,
  // so the cognitoId lookup misses. Email is Cognito-verified for both auth methods.
  if (!user) {
    const email = event.request.userAttributes.email;
    const emailVerified = event.request.userAttributes.email_verified;
    if (email && emailVerified === 'true') {
      [user] = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      if (user) {
        console.log('[pretoken] step=1/email-fallback', { cognitoId, email, userId: user.id });
      }
    }
  }

  console.log('[pretoken] step=1/user', { found: !!user, id: user?.id });

  if (!user) {
    // User not in DB yet — new signup, middleware will create them on first API call
    return emptyClaimsResponse(event);
  }

  // Step 2 — find tenant membership for this user
  // If clientMetadata.tenantId is present (e.g. workspace-switch flow), try that tenant first.
  // Falls back to iterating all active memberships (most recently joined first) until one has
  // a valid subscription. This prevents a tenant with only cancelled subscriptions from
  // blocking login when the user belongs to other valid tenants.
  const requestedTenantId = event.request.clientMetadata?.tenantId || user.pendingTenantId || undefined;

  let candidateMemberships: (typeof memberships.$inferSelect)[] = [];

  if (requestedTenantId) {
    // Workspace-switch: try requested tenant first, then fall through to others
    const [requested] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, user.id),
          eq(memberships.tenantId, requestedTenantId),
          eq(memberships.status, 'active')
        )
      )
      .limit(1);
    if (requested) candidateMemberships.push(requested);
  }

  // Fetch all remaining active memberships ordered by most recently joined
  // NULLs sort last in DESC — newly created memberships without joinedAt will be
  // tried after established ones, but still tried before giving up entirely
  const allMemberships = await db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, user.id),
        eq(memberships.status, 'active')
      )
    )
    .orderBy(desc(memberships.joinedAt));

  // Merge: requested tenant first (if any), then the rest deduped
  for (const m of allMemberships) {
    if (!candidateMemberships.find(c => c.id === m.id)) {
      candidateMemberships.push(m);
    }
  }

  console.log('[pretoken] step=2/memberships', {
    count: candidateMemberships.length,
    requestedTenantId: requestedTenantId ?? null,
  });

  if (candidateMemberships.length === 0) {
    // User exists but has no tenant yet — needs to complete onboarding
    return emptyClaimsResponse(event);
  }

  // Clear pending_tenant_id — it's been consumed
  if (user.pendingTenantId) {
    await db.update(users).set({ pendingTenantId: null }).where(eq(users.id, user.id));
  }

  // Steps 3+4 — walk candidates until one has a valid subscription
  let membership: typeof memberships.$inferSelect | undefined;
  let role: typeof roles.$inferSelect | undefined;
  let subscription: typeof subscriptions.$inferSelect | undefined;

  for (const candidate of candidateMemberships) {
    // Step 3 — resolve role name from roleId
    const [candidateRole] = await db
      .select()
      .from(roles)
      .where(eq(roles.id, candidate.roleId))
      .limit(1);

    if (!candidateRole) {
      console.log('[pretoken] step=3/role missing', { membershipId: candidate.id });
      continue;
    }

    // Step 4 — find active OR trialing subscription to get the plan
    // IMPORTANT: newly created subscriptions default to 'trialing', not 'active'.
    // Filtering for 'active' only causes this step to always miss after onboarding.
    const [candidateSubscription] = await db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.tenantId, candidate.tenantId),
          inArray(subscriptions.status, ['active', 'trialing'])
        )
      )
      .limit(1);

    if (!candidateSubscription) {
      console.log('[pretoken] step=4/no subscription', { tenantId: candidate.tenantId });
      continue;
    }

    // Found a valid candidate — use it
    membership = candidate;
    role = candidateRole;
    subscription = candidateSubscription;
    break;
  }

  console.log('[pretoken] step=4/resolved', {
    found: !!membership,
    tenantId: membership?.tenantId,
    role: role?.name,
    plan: subscription?.plan,
  });

  if (!membership || !role || !subscription) {
    // No active membership has a valid subscription — stamp empty claims
    return emptyClaimsResponse(event);
  }

  // Step 5 — stamp real claims into the JWT
  // These claims are read by middleware on every API request
  // Cast to any because @types/aws-lambda often lags behind V2_0 response shapes
  (event as any).response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:tenantId': membership.tenantId,
          'custom:role': role.name,
          'custom:plan': subscription.plan,
        },
      },
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:tenantId': membership.tenantId,
          'custom:role': role.name,
          'custom:plan': subscription.plan,
        },
      },
    },
  };

  console.log('[pretoken] step=5/done — claims stamped', {
    tenantId: membership.tenantId,
    role: role.name,
    plan: subscription.plan,
  });

  return event;
};

/**
 * Helper — stamps platform_admin role with no tenant
 * Platform admins live in the ops portal and have no tenant association
 */
const platformAdminClaimsResponse = (event: PreTokenGenerationTriggerEvent) => {
  (event as any).response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:tenantId': '',
          'custom:role': 'platform_admin',
          'custom:plan': 'free',
        },
      },
      accessTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:tenantId': '',
          'custom:role': 'platform_admin',
          'custom:plan': 'free',
        },
      },
    },
  };
  return event;
};

/**
 * Helper — stamps empty claims and returns event
 * Used for all cases where tenant context cannot be resolved
 * Empty tenantId signals frontend to redirect to /onboarding
 */
const emptyClaimsResponse = (event: PreTokenGenerationTriggerEvent) => {
  (event as any).response = {
    claimsAndScopeOverrideDetails: {
      idTokenGeneration: {
        claimsToAddOrOverride: {
          'custom:tenantId': '',
          'custom:role': '',
          'custom:plan': 'free',
        },
      },
    },
  };
  return event;
};