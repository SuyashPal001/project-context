import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PRODUCT_CATEGORIES } from '../lib/productCategories';

// The web app can't import this backend package (separate runtime/deployment),
// so apps/web/components/platform/chat/creative-library/productCategories.ts
// keeps its own copy of the same list for the <Select>. If they drift, the web
// form offers a category the API's z.enum(PRODUCT_CATEGORIES) then rejects with
// a 400 — this test is the only thing that would catch that before a user does.
describe('PRODUCT_CATEGORIES stays in sync with the web copy', () => {
  it('matches apps/web/.../productCategories.ts exactly, same order', () => {
    const webFile = join(__dirname, '../../../../../apps/web/components/platform/chat/creative-library/productCategories.ts');
    const source = readFileSync(webFile, 'utf8');
    const match = /PRODUCT_CATEGORIES = \[([\s\S]*?)\] as const/.exec(source);
    if (!match) throw new Error('Could not find PRODUCT_CATEGORIES array in the web copy — did it move or get renamed?');
    const webCategories = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(webCategories).toEqual([...PRODUCT_CATEGORIES]);
  });
});
