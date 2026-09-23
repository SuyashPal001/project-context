import { load } from 'cheerio';

export interface ExtractedProduct {
  title: string | null;
  description: string | null;
  price: string | null;
  imageUrls: string[];
}

const MAX_IMAGE_CANDIDATES = 6;
const MIN_IMAGE_DIMENSION = 200;
const SKIP_IMAGE_FILENAME = /logo|icon|sprite/i;

function resolveUrl(candidate: string, pageUrl: string): string | null {
  try {
    return new URL(candidate, pageUrl).href;
  } catch {
    return null; // malformed src — skip rather than throw, one bad <img> must not fail the whole extract
  }
}

interface JsonLdOffer {
  price?: unknown;
  priceCurrency?: unknown;
  lowPrice?: unknown;
}

function priceFromOffer(offer: JsonLdOffer | undefined): string | null {
  if (!offer) return null;
  const currency = typeof offer.priceCurrency === 'string' ? ` ${offer.priceCurrency}` : '';
  if (offer.price != null) return `${offer.price}${currency}`;
  if (offer.lowPrice != null) return `${offer.lowPrice}${currency}`; // AggregateOffer shape
  return null;
}

function priceFromProduct(candidate: unknown): string | null {
  const offers = (candidate as { offers?: JsonLdOffer | JsonLdOffer[] })?.offers;
  const offer = Array.isArray(offers) ? offers[0] : offers;
  return priceFromOffer(offer);
}

function jsonLdCandidates($: ReturnType<typeof load>): unknown[] {
  const out: unknown[] = [];
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(script).text());
    } catch {
      continue; // one malformed JSON-LD block must not fail extraction
    }
    // Shopify/Yoast/WooCommerce commonly nest the Product under a top-level
    // @graph array rather than at the document root.
    const graph = (parsed as { '@graph'?: unknown[] })?.['@graph'];
    out.push(...(Array.isArray(graph) ? graph : Array.isArray(parsed) ? parsed : [parsed]));
  }
  return out;
}

function readJsonLdPrice(candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const price = priceFromProduct(candidate);
    if (price) return price;
  }
  return null;
}

/** Product.image may be a string, an ImageObject {url}, or an array of either. */
function jsonLdImages(candidates: unknown[]): string[] {
  const out: string[] = [];
  for (const candidate of candidates) {
    const image = (candidate as { image?: unknown } | null)?.image;
    const entries = Array.isArray(image) ? image : [image];
    for (const entry of entries) {
      if (typeof entry === 'string') out.push(entry);
      else if (typeof (entry as { url?: unknown } | null)?.url === 'string') out.push((entry as { url: string }).url);
    }
  }
  return out;
}

export function extractProductPage(html: string, pageUrl: string): ExtractedProduct {
  const $ = load(html);

  const title = $('meta[property="og:title"]').attr('content')?.trim()
    || $('title').first().text().trim()
    || null;

  const description = $('meta[property="og:description"]').attr('content')?.trim()
    || $('meta[name="description"]').attr('content')?.trim()
    || null;

  const ldCandidates = jsonLdCandidates($);
  const price = readJsonLdPrice(ldCandidates)
    || $('meta[property="product:price:amount"]').attr('content')?.trim()
    || null;

  const imageUrls: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (raw: string | undefined) => {
    if (!raw || imageUrls.length >= MAX_IMAGE_CANDIDATES) return;
    const resolved = resolveUrl(raw, pageUrl);
    if (!resolved || seen.has(resolved)) return;
    seen.add(resolved);
    imageUrls.push(resolved);
  };

  $('meta[property="og:image"]').each((_, el) => addCandidate($(el).attr('content')));

  // Tiers are fallbacks, not additive: og:image, then JSON-LD Product.image
  // (only if og:image found nothing), then the body <img> scan as a last
  // resort. The scan is noisy and must not mix thumbnails/icons into a page
  // that already gave a clean answer.
  if (imageUrls.length === 0) jsonLdImages(ldCandidates).forEach(addCandidate);

  if (imageUrls.length === 0) {
    $('img').each((_, el) => {
      const src = $(el).attr('src');
      if (!src || SKIP_IMAGE_FILENAME.test(src)) return;
      const width = Number($(el).attr('width'));
      const height = Number($(el).attr('height'));
      const hasDims = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0;
      if (hasDims && (width < MIN_IMAGE_DIMENSION || height < MIN_IMAGE_DIMENSION)) return;
      addCandidate(src);
    });
  }

  return { title, description, price, imageUrls: imageUrls.slice(0, MAX_IMAGE_CANDIDATES) };
}
