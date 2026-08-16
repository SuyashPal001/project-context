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

  // Nango wraps the response in a `data` envelope
  // (packages/server/lib/controllers/connect/postSessions.ts:173-179 in
  // Nango's own source) — { data: { token, connect_link, expires_at } },
  // not a flat { token }. Reading `.token` directly silently produced
  // `undefined`, which Nango's Connect UI then rejected with
  // invalid_connect_session_token_format once it reached Google.
  const body = (await resp.json()) as { data: { token: string } };
  return { token: body.data.token };
}
