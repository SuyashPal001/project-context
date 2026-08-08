/**
 * Throttle for routes mounted on the unauthenticated router.
 *
 * Those routes bypass the middleware chain entirely, so nothing else limits
 * them. That matters most where a request costs money: the widget's message
 * relay performs a real, metered LLM call, and the tenant and agent ids that
 * address it are semi-public — they sit in the embed snippet on any client's
 * website. Without a ceiling, anyone who views that page can script unlimited
 * billable inference against the tenant's agent.
 *
 * Scoped per IP *and* per tenant so one embed cannot exhaust another's budget.
 *
 * Degrades open: if the cache is unavailable the request proceeds, matching the
 * existing pattern in packs.public.ts. A visitor refused because Redis blinked
 * is worse than the rate this guards.
 */

export const PUBLIC_LIMITS = {
  /** Creating a conversation — cheap, but must not be unbounded. */
  widgetCreate: 10,
  /** Reading message history — no model call. */
  widgetRead: 60,
  /** Sending a message — triggers a metered LLM call, so the tightest. */
  widgetSend: 15,
} as const;

interface CounterCache {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

type HeaderBag = Record<string, string | string[] | undefined> | { get(name: string): string | undefined };

const WINDOW_SECONDS = 60;

function header(headers: HeaderBag, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    return (headers as { get(n: string): string | undefined }).get(name) ?? undefined;
  }
  const v = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Best-effort client IP. Proxies append, so the leftmost entry is the client. */
export function clientIp(headers: HeaderBag): string {
  return (
    header(headers, 'cf-connecting-ip') ??
    header(headers, 'x-forwarded-for')?.split(',')[0]?.trim() ??
    header(headers, 'x-real-ip') ??
    'unknown'
  );
}

/** True when this caller has exceeded `limit` requests in the current window. */
export async function overPublicRateLimit(
  cache: CounterCache,
  headers: HeaderBag,
  tenantId: string,
  bucket: string,
  limit: number,
): Promise<boolean> {
  const key = `ratelimit:public:${bucket}:${tenantId}:${clientIp(headers)}`;
  try {
    const count = await cache.incr(key);
    if (count === 1) await cache.expire(key, WINDOW_SECONDS);
    return count > limit;
  } catch {
    return false; // see module comment — degrade open
  }
}
