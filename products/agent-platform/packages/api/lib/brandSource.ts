const HANDLE = /^[a-z0-9._]{1,30}$/;
const IG_HOST = /^(www\.)?instagram\.com$/i;

export type BrandSource = { type: 'website'; url: string } | { type: 'instagram'; handle: string };

/** One input box, two kinds of link: an Instagram handle/profile URL, or a website. */
export function parseBrandSource(raw: string): BrandSource | null {
  const value = raw.trim();
  if (!value) return null;

  if (value.startsWith('@')) {
    const handle = value.slice(1).toLowerCase();
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  const withScheme = /^[a-z]+:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL | null = null;
  try { url = new URL(withScheme); } catch { url = null; }

  if (url && IG_HOST.test(url.hostname)) {
    const handle = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? '';
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  if (!value.includes('.') && !value.includes('/')) {
    const handle = value.toLowerCase();
    return HANDLE.test(handle) ? { type: 'instagram', handle } : null;
  }

  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) return null;
  if (!/\.[a-z]{2,}$/i.test(url.hostname)) return null;
  url.protocol = 'https:';
  return { type: 'website', url: url.href };
}
