import { describe, it, expect, vi, beforeEach } from 'vitest';

const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({ lookup: lookupMock }));

import { assertPublicHttpUrl, fetchPublicUrl, SsrfBlockedError } from '../lib/ssrfGuard';

describe('assertPublicHttpUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects non-http(s) schemes before any DNS lookup', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com')).rejects.toThrow(SsrfBlockedError);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('allows a hostname that resolves to a public IPv4 address', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    await expect(assertPublicHttpUrl('https://example.com')).resolves.toBeUndefined();
  });

  it('blocks a hostname that resolves to a private IPv4 address', async () => {
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
    await expect(assertPublicHttpUrl('https://internal.example.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('blocks the cloud metadata address', async () => {
    lookupMock.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicHttpUrl('http://metadata.example.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('blocks if ANY resolved address is private, even with a public one present', async () => {
    lookupMock.mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(assertPublicHttpUrl('https://example.com')).rejects.toThrow(SsrfBlockedError);
  });

  // Additional per-range coverage: the brief's self-review checklist calls out every
  // one of these ranges by name, but the base test set above only exercises 10/8 and
  // the metadata address. Each case here pins one specific branch in isPrivateIPv4 /
  // isPrivateIPv6 so a regression in that branch (not just "private IP handling" in
  // general) fails a specific test.
  it.each([
    ['172.16.0.1', '172.16.0.0/12 lower bound'],
    ['172.31.255.255', '172.16.0.0/12 upper bound'],
    ['192.168.1.1', '192.168.0.0/16'],
    ['127.0.0.1', '127.0.0.0/8 loopback'],
    ['0.0.0.5', '0.0.0.0/8'],
  ])('blocks IPv4 %s (%s)', async (address) => {
    lookupMock.mockResolvedValue([{ address, family: 4 }]);
    await expect(assertPublicHttpUrl('https://internal.example.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('does not block an address just outside the 172.16/12 range (172.32.0.1)', async () => {
    lookupMock.mockResolvedValue([{ address: '172.32.0.1', family: 4 }]);
    await expect(assertPublicHttpUrl('https://example.com')).resolves.toBeUndefined();
  });

  it.each([
    ['::1', '::1 loopback'],
    ['fc00::1', 'fc00::/7 unique local (fc)'],
    ['fd12:3456::1', 'fc00::/7 unique local (fd)'],
    ['fe80::1', 'fe80::/10 link-local'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata address'],
  ])('blocks IPv6 %s (%s)', async (address) => {
    lookupMock.mockResolvedValue([{ address, family: 6 }]);
    await expect(assertPublicHttpUrl('https://internal.example.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('allows a hostname that resolves to a public IPv6 address', async () => {
    lookupMock.mockResolvedValue([{ address: '2001:4860:4860::8888', family: 6 }]);
    await expect(assertPublicHttpUrl('https://example.com')).resolves.toBeUndefined();
  });

  it('blocks when DNS resolves to no addresses at all', async () => {
    lookupMock.mockResolvedValue([]);
    await expect(assertPublicHttpUrl('https://nowhere.example.com')).rejects.toThrow(SsrfBlockedError);
  });
});

describe('fetchPublicUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('re-validates DNS on every redirect hop', async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]) // first hop: public
      .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]); // redirect target: private

    global.fetch = vi.fn().mockResolvedValueOnce({
      status: 302,
      headers: { get: () => 'http://internal.example.com/secret' },
    }) as unknown as typeof fetch;

    await expect(fetchPublicUrl('https://public.example.com')).rejects.toThrow(SsrfBlockedError);
    expect(lookupMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_REDIRECTS hops even if every hop is public', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: { get: () => 'https://public.example.com/next' },
    }) as unknown as typeof fetch;

    await expect(fetchPublicUrl('https://public.example.com')).rejects.toThrow(/Too many redirects/);
  });

  it('streams the body and enforces the download size cap', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const bigChunk = new Uint8Array(51 * 1024 * 1024);
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      body: { [Symbol.asyncIterator]: async function* () { yield bigChunk; } },
    }) as unknown as typeof fetch;

    await expect(fetchPublicUrl('https://public.example.com/big.zip')).rejects.toThrow(/download limit/);
  });

  it('ignores a lying Content-Length header and only counts actual streamed bytes', async () => {
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const smallChunk = new Uint8Array(10);
    global.fetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: (name: string) => (name.toLowerCase() === 'content-length' ? '5' : null) },
      body: { [Symbol.asyncIterator]: async function* () { yield smallChunk; } },
    }) as unknown as typeof fetch;

    const result = await fetchPublicUrl('https://public.example.com/small.bin');
    expect(result.length).toBe(10);
  });
});
