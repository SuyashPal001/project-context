import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getGmailAccessToken } from './nangoGmail';

const ORIGINAL_HOST = process.env.NANGO_HOST;
const ORIGINAL_KEY = process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;

describe('getGmailAccessToken', () => {
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

  it('returns the access token from a healthy connection', async () => {
    (fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({ credentials: { access_token: 'ya29.live-token' } }),
    });

    const token = await getGmailAccessToken('tenant-1');

    expect(token).toBe('ya29.live-token');
    expect(fetch).toHaveBeenCalledWith(
      'https://nango.projectcontext.co/connection/tenant-1?provider_config_key=google-mail',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-secret' }),
      }),
    );
  });

  it('throws when Nango has no connection for the tenant', async () => {
    (fetch as any).mockResolvedValue({ ok: false, status: 404, text: async () => 'not found' });

    await expect(getGmailAccessToken('tenant-no-gmail')).rejects.toThrow(
      /no active Gmail connection/i,
    );
  });

  it('throws when NANGO_HOST is not configured', async () => {
    delete process.env.NANGO_HOST;
    await expect(getGmailAccessToken('tenant-1')).rejects.toThrow(/NANGO_HOST/);
  });

  it('throws when NANGO_SECRET_KEY_PROJECT_CONTEXT is not configured', async () => {
    delete process.env.NANGO_SECRET_KEY_PROJECT_CONTEXT;
    await expect(getGmailAccessToken('tenant-1')).rejects.toThrow(
      /NANGO_SECRET_KEY_PROJECT_CONTEXT/,
    );
  });
});
