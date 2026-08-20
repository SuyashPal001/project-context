import { lookup } from 'dns/promises';

// isSafeHttpUrl (agent-api/lib/safe-url.ts) only checks the URL scheme and
// isn't exported from that package anyway — this is new, real SSRF
// protection for the one place in this design that fetches a tenant-supplied
// URL server-side: resolve the hostname and reject private/loopback/
// link-local ranges, then re-validate on every redirect hop so a public host
// can't 302 the request to an internal address after the first check passes.
export class SsrfBlockedError extends Error {}

const MAX_REDIRECTS = 3;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024; // matches safeSkillZip's total-size cap

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed → unsafe
  const [a, b] = parts;
  if (a === 10) return true;                       // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 127) return true;                       // loopback
  if (a === 169 && b === 254) return true;          // link-local incl. cloud metadata 169.254.169.254
  if (a === 0) return true;                         // "this network"
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 unique local
  if (lower.startsWith('fe80')) return true;                         // fe80::/10 link-local
  if (lower.startsWith('::ffff:')) return isPrivateIPv4(lower.slice('::ffff:'.length));
  return false;
}

function isSafeScheme(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export async function assertPublicHttpUrl(url: string): Promise<void> {
  if (!isSafeScheme(url)) {
    throw new SsrfBlockedError('URL must use http or https');
  }
  const { hostname } = new URL(url);
  const addresses = await lookup(hostname, { all: true });
  if (addresses.length === 0) {
    throw new SsrfBlockedError(`Could not resolve host: ${hostname}`);
  }
  for (const { address, family } of addresses) {
    const isPrivate = family === 4 ? isPrivateIPv4(address) : family === 6 ? isPrivateIPv6(address) : true;
    if (isPrivate) {
      throw new SsrfBlockedError(`Host resolves to a non-public address: ${hostname}`);
    }
  }
}

export async function fetchPublicUrl(startUrl: string): Promise<Buffer> {
  let currentUrl = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(currentUrl);

    const res = await fetch(currentUrl, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new SsrfBlockedError('Redirect response had no Location header');
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`Fetch failed with status ${res.status}`);
    }
    if (!res.body) {
      throw new Error('Fetch response had no body');
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_DOWNLOAD_BYTES) {
        throw new Error(`Response exceeds the ${MAX_DOWNLOAD_BYTES}-byte download limit`);
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new SsrfBlockedError(`Too many redirects (max ${MAX_REDIRECTS})`);
}
