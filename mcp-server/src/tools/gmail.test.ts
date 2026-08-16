import { describe, it, expect, vi } from 'vitest';

vi.mock('../integrations/nangoGmail', () => ({
  getGmailAccessToken: vi.fn(),
}));
vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: vi.fn().mockImplementation(() => ({ setCredentials: vi.fn() })) },
    gmail: vi.fn().mockReturnValue({ users: { messages: {} } }),
  },
}));

import { getGmailAccessToken } from '../integrations/nangoGmail';
import { google } from 'googleapis';

// getGmailClient isn't exported today — this test drives it indirectly via
// registerGmailTools once Step 2 below lands; see that step's note.
describe('gmail client construction uses Nango', () => {
  it('fetches the access token from Nango and sets it on the OAuth2 client', async () => {
    (getGmailAccessToken as any).mockResolvedValue('ya29.from-nango');
    const { getGmailClient } = await import('./gmail');
    await getGmailClient('tenant-1');

    expect(getGmailAccessToken).toHaveBeenCalledWith('tenant-1');
    const oauth2Instance = (google.auth.OAuth2 as any).mock.results[0].value;
    expect(oauth2Instance.setCredentials).toHaveBeenCalledWith({
      access_token: 'ya29.from-nango',
    });
  });
});
