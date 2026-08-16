import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createNangoConnectSession } from './integrations.nango';

const ORIGINAL_HOST = process.env.NANGO_HOST;
const ORIGINAL_KEY = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;

describe('createNangoConnectSession', () => {
  beforeEach(() => {
    process.env.NANGO_HOST = 'https://nango.projectcontext.co';
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = 'test-secret';
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env.NANGO_HOST = ORIGINAL_HOST;
    process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT = ORIGINAL_KEY;
    vi.unstubAllGlobals();
  });

  it('creates a session scoped to google-mail for the given tenant', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        data: { token: 'session-tok', connect_link: 'https://connect.example.com/x', expires_at: '2026-08-11T20:00:00Z' },
      }),
    });

    const result = await createNangoConnectSession('tenant-1');

    expect(result).toEqual({ token: 'session-tok' });
    expect(fetch).toHaveBeenCalledWith(
      'https://nango.projectcontext.co/connect/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-secret',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          end_user: { id: 'tenant-1' },
          allowed_integrations: ['google-mail'],
        }),
      }),
    );
  });

  it('throws when Nango rejects the request', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(createNangoConnectSession('tenant-1')).rejects.toThrow(
      /connect session creation failed/i,
    );
  });
});
