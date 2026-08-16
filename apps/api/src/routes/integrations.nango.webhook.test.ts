import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { Hono } from 'hono';

const mockAuditInsert = vi.fn().mockReturnValue({ catch: vi.fn() });
vi.mock('@serverless-saas/database', () => ({
  db: { execute: vi.fn(), insert: vi.fn(() => ({ values: mockAuditInsert })) },
}));
vi.mock('./integrations.sync', () => ({ syncToolsAndNotifyRelay: vi.fn() }));

import { db } from '@serverless-saas/database';
import { syncToolsAndNotifyRelay } from './integrations.sync';
import { nangoWebhookRoute } from './integrations.nango.webhook';

const SECRET = 'whsec_test';
const ORIGINAL = process.env.NANGO_WEBHOOK_SECRET;

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('POST /integrations/webhooks/nango', () => {
  const app = new Hono().route('/integrations', nangoWebhookRoute);

  beforeEach(() => {
    process.env.NANGO_WEBHOOK_SECRET = SECRET;
    (db.execute as any).mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env.NANGO_WEBHOOK_SECRET = ORIGINAL;
    vi.clearAllMocks();
  });

  it('rejects a request with an invalid signature', async () => {
    const body = JSON.stringify({ type: 'auth', success: true });
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': 'wrong', 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('rejects a request with no signature header', async () => {
    const body = JSON.stringify({ type: 'auth', success: true });
    const res = await app.request('/integrations/webhooks/nango', { method: 'POST', body });
    expect(res.status).toBe(401);
  });

  it('records the connection using endUser.endUserId, not Nango\'s own connectionId', async () => {
    // connectionId is deliberately a different value here — Nango generates
    // its own internal connection identifier via /connect/sessions (no way
    // to set it directly), so it is NOT our tenantId. Only endUser.endUserId
    // carries the real tenantId we set as end_user.id when creating the
    // session. Confirmed live: every webhook insert that used connectionId
    // as tenantId failed with a foreign_key_violation against `tenants`.
    const payload = {
      type: 'auth',
      success: true,
      connectionId: 'nango-internal-connection-id-xyz',
      providerConfigKey: 'google-mail',
      endUser: { endUserId: 'tenant-1', endUserEmail: null, tags: {} },
    };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });

    expect(res.status).toBe(200);
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalledTimes(1);
    expect(mockAuditInsert).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      actorId: 'nango-webhook',
      actorType: 'system',
      action: 'integration_connected',
      resource: 'integration',
      metadata: { provider: 'gmail' },
    }));
    expect(syncToolsAndNotifyRelay).toHaveBeenCalledWith('tenant-1', 'gmail', 'add');
  });

  it('falls back to connectionId if endUser is absent', async () => {
    const payload = {
      type: 'auth',
      success: true,
      connectionId: 'tenant-1',
      providerConfigKey: 'google-mail',
    };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });

    expect(res.status).toBe(200);
    expect(syncToolsAndNotifyRelay).toHaveBeenCalledWith('tenant-1', 'gmail', 'add');
  });

  it('ignores a non-google-mail provider without erroring', async () => {
    const payload = { type: 'auth', success: true, connectionId: 'tenant-1', providerConfigKey: 'slack' };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(db.execute).not.toHaveBeenCalled();
    expect(syncToolsAndNotifyRelay).not.toHaveBeenCalled();
  });

  it('ignores a failed auth event without writing a row', async () => {
    const payload = { type: 'auth', success: false, connectionId: 'tenant-1', providerConfigKey: 'google-mail' };
    const body = JSON.stringify(payload);
    const res = await app.request('/integrations/webhooks/nango', {
      method: 'POST',
      headers: { 'x-nango-hmac-sha256': sign(body), 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(db.execute).not.toHaveBeenCalled();
  });
});
