import { describe, it, expect } from 'vitest';
import { extractBrandPage, sourceTextOf } from '../lib/brandPageExtract';

const URL_ = 'https://mamaearth.example/';
const html = `<html><head>
  <title>Mamaearth | Toxin-free</title>
  <meta property="og:site_name" content="Mamaearth">
  <meta name="description" content="Natural skincare for India.">
  <meta name="theme-color" content="#00A651">
  <link rel="icon" href="/favicon.ico"><link rel="apple-touch-icon" href="/apple.png">
  <link rel="stylesheet" href="/main.css">
  <script type="application/ld+json">{"@type":"Organization","name":"Mamaearth","logo":"https://cdn.example/logo.png"}</script>
  <style>:root{--brand:#00a651;--ink:#1A1A1A} .x{color:#00A651}</style>
</head><body>
  <h1>Goodness Inside</h1><h2>Made safe for you</h2>
  <a class="btn" href="/shop">Shop now</a><button>Add to cart</button><a href="/about">About us</a>
  <img src="/brand-logo.svg" alt="Mamaearth logo">
  <p>Every product is toxin-free.</p>
</body></html>`;

describe('extractBrandPage', () => {
  it('reads name, description, headings and calls to action', () => {
    const f = extractBrandPage(html, URL_);
    expect(f.siteName).toBe('Mamaearth');
    expect(f.description).toBe('Natural skincare for India.');
    expect(f.headings).toEqual(['Goodness Inside', 'Made safe for you']);
    expect(f.ctas).toEqual(expect.arrayContaining(['Shop now', 'Add to cart']));
    expect(f.ctas).not.toContain('About us');
  });

  it('puts the JSON-LD logo first and never offers an SVG', () => {
    const f = extractBrandPage(html, URL_);
    expect(f.logoCandidates[0]).toBe('https://cdn.example/logo.png');
    expect(f.logoCandidates.some((u) => u.endsWith('.svg'))).toBe(false);
    expect(f.iconUrls).toEqual(['https://mamaearth.example/apple.png', 'https://mamaearth.example/favicon.ico']);
  });

  it('collects theme colour, CSS colours by frequency and fonts from linked CSS', () => {
    const f = extractBrandPage(html, URL_, `body{font-family:"Poppins", Arial, sans-serif} h1{color:#F7B500}`);
    expect(f.themeColor).toBe('#00A651');
    expect(f.cssColors[0]).toBe('#00A651');
    expect(f.cssColors).toContain('#F7B500');
    expect(f.fonts).toEqual(['Poppins', 'Arial']);
    expect(f.stylesheetUrl).toBe('https://mamaearth.example/main.css');
  });

  it('copes with an empty page', () => {
    const f = extractBrandPage('<html></html>', URL_);
    expect(f).toMatchObject({ siteName: null, headings: [], logoCandidates: [], cssColors: [], fonts: [] });
  });
});

describe('sourceTextOf', () => {
  it('joins every visible text field for the verbatim phrase check', () => {
    const text = sourceTextOf(extractBrandPage(html, URL_));
    expect(text).toContain('Goodness Inside');
    expect(text).toContain('toxin-free');
  });
});
