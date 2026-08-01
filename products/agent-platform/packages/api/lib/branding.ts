/**
 * Branding fields shared by tenants (the agency) and clients.
 * A client-level value of `null` means "inherit"; any non-null value —
 * including the empty string — is an intentional override.
 */
export interface BrandFields {
  brandName: string | null;
  logoUrl: string | null;
  brandColor: string | null;
}

export function resolveBranding(
  client: BrandFields | null,
  tenant: BrandFields,
): BrandFields {
  if (!client) return { ...tenant };
  return {
    brandName: client.brandName ?? tenant.brandName,
    logoUrl: client.logoUrl ?? tenant.logoUrl,
    brandColor: client.brandColor ?? tenant.brandColor,
  };
}
