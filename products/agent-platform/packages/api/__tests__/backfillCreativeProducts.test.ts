import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));
vi.mock('@serverless-saas/storage', () => ({ storageService: {} }));

import { selectBackfillCandidates } from '../scripts/backfill-creative-products';

describe('selectBackfillCandidates', () => {
  it('keeps unreferenced image files and skips referenced or non-image ones', () => {
    const files = [
      { id: 'a', tenantId: 't1', uploadedBy: null, mimeType: 'image/png' },
      { id: 'b', tenantId: 't1', uploadedBy: null, mimeType: 'image/jpeg' },
      { id: 'c', tenantId: 't1', uploadedBy: null, mimeType: 'application/pdf' },
      { id: 'd', tenantId: 't2', uploadedBy: 'u1', mimeType: 'image/webp' },
    ];
    expect(selectBackfillCandidates(files, new Set(['b'])).map(f => f.id)).toEqual(['a', 'd']);
  });
});
