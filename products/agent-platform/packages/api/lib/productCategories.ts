// A small fixed list, not a full taxonomy — chosen over a deep category tree
// (e.g. Google's Product Taxonomy) so this stays simple to validate and
// display. Mirrored in apps/web/components/platform/chat/creative-library/productCategories.ts
// for the create/edit form's <select>; keep both lists identical.
export const PRODUCT_CATEGORIES = [
  'Apparel',
  'Beauty & Personal Care',
  'Electronics',
  'Home & Kitchen',
  'Food & Beverage',
  'Health & Wellness',
  'Toys & Games',
  'Accessories',
  'Other',
] as const;

export type ProductCategory = typeof PRODUCT_CATEGORIES[number];

export function isProductCategory(value: unknown): value is ProductCategory {
  return typeof value === 'string' && (PRODUCT_CATEGORIES as readonly string[]).includes(value);
}
