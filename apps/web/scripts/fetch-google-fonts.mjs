#!/usr/bin/env node
// Downloads the Google Fonts metadata list and writes a small static JSON
// (family + category only) for the brand "Other font" search — no API key.
// Run once, commit the output: node apps/web/scripts/fetch-google-fonts.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://fonts.google.com/metadata/fonts';
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'components', 'platform', 'brand', 'googleFonts.json',
);

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    console.error(`NEEDS_CONTEXT: ${SOURCE_URL} returned ${res.status}`);
    process.exit(1);
  }
  let text = await res.text();
  // The response is prefixed with `)]}'` as an anti-JSONP-hijack guard.
  text = text.replace(/^\)\]\}'\s*\n?/, '');

  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    console.error('NEEDS_CONTEXT: could not parse fonts.google.com metadata JSON', err);
    process.exit(1);
  }

  const list = data?.familyMetadataList;
  if (!Array.isArray(list) || list.length === 0) {
    console.error('NEEDS_CONTEXT: familyMetadataList missing or empty in metadata response');
    process.exit(1);
  }

  const fonts = list
    .filter((f) => typeof f?.family === 'string' && f.family.trim())
    .map((f) => ({ family: f.family, category: typeof f.category === 'string' ? f.category : 'sans-serif' }))
    .sort((a, b) => a.family.localeCompare(b.family));

  writeFileSync(OUT_PATH, `${JSON.stringify(fonts, null, 2)}\n`);
  console.log(`Wrote ${fonts.length} fonts to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('NEEDS_CONTEXT: unexpected error fetching Google Fonts metadata', err);
  process.exit(1);
});
