import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { productsToRename } from '../scripts/rename-product-files';

describe('productsToRename', () => {
  it('keeps only named products with images', () => {
    const rows = [
      { id: 'a', tenantId: 't', name: 'Serum', imageFileIds: ['f1'], namingStatus: 'done' as const },
      { id: 'b', tenantId: 't', name: 'Untitled product', imageFileIds: ['f2'], namingStatus: 'pending' as const },
      { id: 'c', tenantId: 't', name: 'X', imageFileIds: [], namingStatus: 'done' as const },
      { id: 'd', tenantId: 't', name: 'Untitled product', imageFileIds: ['f3'], namingStatus: 'failed' as const },
    ];
    expect(productsToRename(rows).map(r => r.id)).toEqual(['a']);
  });
});
