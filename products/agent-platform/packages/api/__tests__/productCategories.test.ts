import { describe, it, expect } from 'vitest';
import { PRODUCT_CATEGORIES, isProductCategory } from '../lib/productCategories';

describe('isProductCategory', () => {
  it('accepts every value in the fixed list', () => {
    for (const category of PRODUCT_CATEGORIES) expect(isProductCategory(category)).toBe(true);
  });

  it('rejects a string not in the list', () => {
    expect(isProductCategory('Automotive')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isProductCategory(null)).toBe(false);
    expect(isProductCategory(42)).toBe(false);
    expect(isProductCategory(undefined)).toBe(false);
  });
});
