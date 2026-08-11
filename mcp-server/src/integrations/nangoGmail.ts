/**
 * Fetches a live Gmail access token from the shared Nango instance.
 * Nango owns token storage/refresh for Gmail — connections are keyed by
 * tenantId (the identifier apps/api and mcp-server already share).
 */
export async function getGmailAccessToken(tenantId: string): Promise<string> {
  const host = process.env.NANGO_HOST;
  if (!host) throw new Error('NANGO_HOST env var not set');

  const secretKey = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
  if (!secretKey) throw new Error('NANGO_SECRET_KEY_PROJECT_CONTEXT env var not set');

  const url = `${host}/connection/${encodeURIComponent(tenantId)}?provider_config_key=google-mail`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      throw new Error(`No active Gmail connection for tenant ${tenantId}`);
    }
    throw new Error(`Nango connection lookup failed with status ${resp.status}`);
  }

  const data = (await resp.json()) as { credentials?: { access_token?: string } };
  const accessToken = data.credentials?.access_token;
  if (!accessToken) {
    throw new Error(`Nango returned no access token for tenant ${tenantId}`);
  }
  return accessToken;
}
