import { load } from 'cheerio';
import { jsonLdCandidates } from './productPageExtract';

export interface WebsiteFacts {
  url: string; siteName: string | null; title: string | null; description: string | null;
  headings: string[]; ctas: string[]; bodyText: string;
  logoCandidates: string[]; iconUrls: string[];
  themeColor: string | null; cssColors: string[]; fonts: string[];
  stylesheetUrl: string | null;
}

const MAX_BODY_TEXT = 3000;
const MAX_HEADINGS = 12;
const MAX_CTAS = 10;
const MAX_COLORS = 12;
const MAX_FONTS = 3;
// Button-ish text: short, and either inside a button or a link styled/labelled as one.
const CTA_WORDS = /\b(shop|buy|order|add to cart|get|try|start|book|subscribe|sign up|join|claim|download|dm|comment|call|whatsapp|explore)\b/i;
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', '-apple-system', 'blinkmacsystemfont', 'ui-sans-serif', 'ui-serif']);
const HEX_RE = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

const clean = (s: string | undefined | null) => (s ?? '').replace(/\s+/g, ' ').trim();
const nonEmpty = (s: string | undefined | null) => clean(s) || null;

function resolve(candidate: string | undefined, base: string): string | null {
  if (!candidate) return null;
  try {
    const u = new URL(candidate, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u.href : null;
  } catch { return null; }
}

function normaliseHex(raw: string): string {
  const h = raw.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return `#${full.toUpperCase()}`;
}

function rankColors(css: string): string[] {
  const counts = new Map<string, number>();
  for (const m of css.matchAll(HEX_RE)) {
    const hex = normaliseHex(m[0]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
  const coloured = ranked.filter((h) => h !== '#FFFFFF' && h !== '#000000');
  return (coloured.length > 0 ? coloured : ranked).slice(0, MAX_COLORS);
}

function rankFonts(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/font-family\s*:\s*([^;}]+)/gi)) {
    for (const part of m[1].split(',')) {
      const name = part.replace(/["']/g, '').replace(/!important/i, '').trim();
      if (!name || GENERIC_FONTS.has(name.toLowerCase()) || name.startsWith('var(')) continue;
      if (!out.includes(name)) out.push(name);
      if (out.length >= MAX_FONTS) return out;
    }
  }
  return out;
}

function jsonLdLogo(candidates: unknown[]): { logo: string | null; name: string | null } {
  for (const c of candidates) {
    const node = c as { '@type'?: unknown; logo?: unknown; name?: unknown } | null;
    const type = node?.['@type'];
    const isOrg = type === 'Organization' || type === 'Brand' || (Array.isArray(type) && type.includes('Organization'));
    if (!isOrg) continue;
    const logo = typeof node?.logo === 'string' ? node.logo
      : typeof (node?.logo as { url?: unknown })?.url === 'string' ? (node!.logo as { url: string }).url : null;
    return { logo, name: typeof node?.name === 'string' ? node.name : null };
  }
  return { logo: null, name: null };
}

export function extractBrandPage(html: string, pageUrl: string, css = ''): WebsiteFacts {
  const $ = load(html);
  const meta = (sel: string) => nonEmpty($(sel).attr('content'));
  const org = jsonLdLogo(jsonLdCandidates($));

  const headings = $('h1, h2, h3').toArray().map((el) => clean($(el).text())).filter((t) => t && t.length <= 120).slice(0, MAX_HEADINGS);

  const ctas: string[] = [];
  $('button, a, input[type=submit]').each((_, el) => {
    const text = clean($(el).text() || $(el).attr('value'));
    if (!text || text.length > 40 || ctas.includes(text)) return;
    const isButton = el.tagName === 'button' || el.tagName === 'input' || /btn|button|cta/i.test($(el).attr('class') ?? '');
    if (isButton || CTA_WORDS.test(text)) ctas.push(text);
  });

  const imgLogos = $('img').toArray()
    .filter((el) => /logo/i.test(`${$(el).attr('alt') ?? ''} ${$(el).attr('src') ?? ''} ${$(el).attr('class') ?? ''}`))
    .map((el) => resolve($(el).attr('src'), pageUrl));
  const logoCandidates = [resolve(org.logo ?? undefined, pageUrl), ...imgLogos]
    .filter((u): u is string => !!u && !/\.svg(\?|$)/i.test(u))
    .filter((u, i, a) => a.indexOf(u) === i);

  const iconUrls = [
    ...$('link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"]').toArray(),
    ...$('link[rel="icon"], link[rel="shortcut icon"]').toArray(),
  ].map((el) => resolve($(el).attr('href'), pageUrl))
    .filter((u): u is string => !!u && !/\.svg(\?|$)/i.test(u))
    .filter((u, i, a) => a.indexOf(u) === i);

  const inlineCss = $('style').toArray().map((el) => $(el).text()).join('\n');
  const allCss = `${inlineCss}\n${css}`;
  const themeRaw = meta('meta[name="theme-color"]');
  const themeColor = themeRaw && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(themeRaw) ? normaliseHex(themeRaw) : null;

  $('script, style, noscript, svg').remove();
  const bodyText = clean($('body').text()).slice(0, MAX_BODY_TEXT);

  return {
    url: pageUrl,
    siteName: meta('meta[property="og:site_name"]') ?? org.name,
    title: nonEmpty($('title').first().text()),
    description: meta('meta[property="og:description"]') ?? meta('meta[name="description"]'),
    headings, ctas: ctas.slice(0, MAX_CTAS), bodyText,
    logoCandidates, iconUrls,
    themeColor, cssColors: rankColors(allCss), fonts: rankFonts(allCss),
    stylesheetUrl: resolve($('link[rel="stylesheet"]').first().attr('href'), pageUrl),
  };
}

/** Every visible text field, for the verbatim signature-phrase check. */
export function sourceTextOf(f: WebsiteFacts): string {
  return [f.siteName, f.title, f.description, ...f.headings, ...f.ctas, f.bodyText].filter(Boolean).join('\n');
}
