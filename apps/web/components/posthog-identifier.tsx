"use client";

import { usePostHog } from "posthog-js/react";
import { useEffect } from "react";
import { useTenant } from "@/app/[tenant]/tenant-provider";

export function PostHogIdentifier() {
  const posthog = usePostHog();
  const claims = useTenant();

  useEffect(() => {
    if (!posthog || !claims?.userId) return;

    posthog.identify(claims.userId, {
      tenantId: claims.tenantId,
      tenantSlug: claims.tenantSlug,
      role: claims.role,
      plan: claims.plan,
    });

    posthog.group("tenant", claims.tenantId, {
      slug: claims.tenantSlug,
      plan: claims.plan,
    });
  }, [posthog, claims]);

  return null;
}
