/**
 * Creates a short-lived Nango connect session scoped to Gmail for one
 * tenant. The returned token is handed to the frontend, which opens
 * Nango's Connect UI with it — Nango owns the OAuth exchange from there.
 */
export async function createNangoConnectSession(tenantId: string): Promise<{ token: string }> {
  const host = process.env.NANGO_HOST;
  if (!host) throw new Error('NANGO_HOST env var not set');

  const secretKey = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
  if (!secretKey) throw new Error('NANGO_SECRET_KEY_PROJECT_CONTEXT env var not set');

  const resp = await fetch(`${host}/connect/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      end_user: { id: tenantId },
      allowed_integrations: ['google-mail'],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Nango connect session creation failed with status ${resp.status}`);
  }

  const data = (await resp.json()) as { token: string };
  return { token: data.token };
}
