/**
 * Scheme allowlist for any URL that will be rendered as a link.
 *
 * `z.string().url()` validates structure, not scheme — it accepts
 * `javascript:alert(1)` and `data:text/html,...`. Pack item URLs are supplied
 * by the agency and rendered as anchors in the client portal, which is
 * same-origin with the app, so an unrestricted scheme is stored XSS.
 *
 * The portal keeps its own copy of this check: it must not trust its input
 * even if a row predates this validation.
 */
export function isSafeHttpUrl(url: string | null | undefined): boolean {
  if (url === null || url === undefined) return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const SAFE_URL_MESSAGE = 'url must be http or https';
