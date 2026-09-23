import { describe, it, expect } from 'vitest';
import { extractProductPage } from '../lib/productPageExtract';

describe('extractProductPage', () => {
  it('prefers og:title over the <title> tag', () => {
    const html = `<html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="Real Product Name">
    </head><body></body></html>`;
    expect(extractProductPage(html, 'https://shop.example.com/p/1').title).toBe('Real Product Name');
  });

  it('falls back to the <title> tag when og:title is absent', () => {
    const html = `<html><head><title>Fallback Title</title></head><body></body></html>`;
    expect(extractProductPage(html, 'https://shop.example.com/p/1').title).toBe('Fallback Title');
  });

  it('returns null title when neither is present', () => {
    const html = `<html><head></head><body></body></html>`;
    expect(extractProductPage(html, 'https://shop.example.com/p/1').title).toBeNull();
  });

  it('prefers og:description over meta name=description', () => {
    const html = `<html><head>
      <meta name="description" content="Fallback desc">
      <meta property="og:description" content="Real desc">
    </head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').description).toBe('Real desc');
  });

  it('reads price from JSON-LD Product.offers.price', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","offers":{"@type":"Offer","price":"49.99","priceCurrency":"USD"}}
    </script></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBe('49.99 USD');
  });

  it('reads price from a JSON-LD @graph wrapper (Shopify/Yoast/WooCommerce shape)', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@graph":[
        {"@type":"WebPage"},
        {"@type":"Product","offers":{"price":"29.00","priceCurrency":"EUR"}}
      ]}
    </script></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBe('29.00 EUR');
  });

  it('reads price from an offers array (takes the first entry)', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","offers":[{"price":"15.00","priceCurrency":"USD"},{"price":"20.00"}]}
    </script></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBe('15.00 USD');
  });

  it('reads price from an AggregateOffer.lowPrice when there is no single price', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","offers":{"@type":"AggregateOffer","lowPrice":"9.99","priceCurrency":"USD"}}
    </script></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBe('9.99 USD');
  });

  it('falls back to product:price:amount meta when JSON-LD is absent', () => {
    const html = `<html><head><meta property="product:price:amount" content="19.00"></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBe('19.00');
  });

  it('returns null price rather than guessing from body text', () => {
    const html = `<html><body><p>Only $49.99 today!</p></body></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').price).toBeNull();
  });

  it('does not fail extraction when a JSON-LD block is malformed', () => {
    const html = `<html><head><script type="application/ld+json">{not valid json</script>
      <meta property="og:title" content="Still Works">
    </head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').title).toBe('Still Works');
  });

  it('collects multiple og:image tags in document order', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/a.jpg">
      <meta property="og:image" content="https://cdn.example.com/b.jpg">
    </head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').imageUrls).toEqual([
      'https://cdn.example.com/a.jpg',
      'https://cdn.example.com/b.jpg',
    ]);
  });

  it('resolves a relative image URL against the page URL', () => {
    const html = `<html><head><meta property="og:image" content="/img/a.jpg"></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com/p/1').imageUrls).toEqual([
      'https://shop.example.com/img/a.jpg',
    ]);
  });

  it('resolves a protocol-relative image URL against the page URL scheme', () => {
    const html = `<html><head><meta property="og:image" content="//cdn.example.com/a.jpg"></head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com/p/1').imageUrls).toEqual([
      'https://cdn.example.com/a.jpg',
    ]);
  });

  it('falls back to <img> tags only when og:image and JSON-LD image both found nothing', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/hero.jpg">
    </head><body><img src="https://cdn.example.com/other.jpg" width="400" height="400"></body></html>`;
    // og:image found something, so the noisy body <img> scan must NOT run at all.
    expect(extractProductPage(html, 'https://shop.example.com').imageUrls).toEqual([
      'https://cdn.example.com/hero.jpg',
    ]);
  });

  it('skips <img> tags whose src looks like a logo or icon, and small images, in the fallback scan', () => {
    const html = `<html><body>
      <img src="/assets/logo.png" width="300" height="300">
      <img src="/assets/tiny.jpg" width="50" height="50">
      <img src="/assets/photo.jpg" width="300" height="300">
    </body></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').imageUrls).toEqual([
      'https://shop.example.com/assets/photo.jpg',
    ]);
  });

  it('dedupes identical resolved image URLs', () => {
    const html = `<html><head>
      <meta property="og:image" content="https://cdn.example.com/a.jpg">
      <meta property="og:image" content="https://cdn.example.com/a.jpg">
    </head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').imageUrls).toEqual([
      'https://cdn.example.com/a.jpg',
    ]);
  });

  it('caps image candidates at 6', () => {
    const images = Array.from({ length: 10 }, (_, i) => `<meta property="og:image" content="https://cdn.example.com/${i}.jpg">`).join('\n');
    const html = `<html><head>${images}</head></html>`;
    expect(extractProductPage(html, 'https://shop.example.com').imageUrls).toHaveLength(6);
  });
});
