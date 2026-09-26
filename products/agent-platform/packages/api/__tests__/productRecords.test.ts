import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { dropImageless, escapeLike, toProductRecord, PRODUCT_NAME_PLACEHOLDER } from '../lib/productRecords';

const baseRow = {
  id: 'p1', tenantId: 't1', name: 'Serum', description: null, price: null, sourceUrl: null,
  imageFileIds: ['f1', 'f2', 'f3'], namingStatus: 'done' as const, createdBy: null,
  createdAt: new Date('2026-09-27T00:00:00.000Z'), updatedAt: new Date('2026-09-27T00:00:00.000Z'),
};
const img = (fileId: string) => ({ fileId, name: `${fileId}.png`, type: 'image/png', size: 10 });

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character so search matches literally', () => {
    expect(escapeLike('50% off_now\\')).toBe('50\\% off\\_now\\\\');
  });
});

describe('toProductRecord', () => {
  it('keeps images in stored order and drops ids whose file row is gone', () => {
    const record = toProductRecord(baseRow, new Map([['f3', img('f3')], ['f1', img('f1')]]));
    expect(record.images.map(i => i.fileId)).toEqual(['f1', 'f3']);
    expect(record.createdAt).toBe('2026-09-27T00:00:00.000Z');
  });

  it('exports the exact placeholder name', () => {
    expect(PRODUCT_NAME_PLACEHOLDER).toBe('Untitled product');
  });
});

describe('dropImageless', () => {
  it('hides a product whose image files were all deleted, keeps one with some left', () => {
    const allGone = toProductRecord(baseRow, new Map());
    const oneLeft = toProductRecord({ ...baseRow, id: 'p2' }, new Map([['f2', img('f2')]]));
    expect(dropImageless([allGone, oneLeft]).map(p => p.id)).toEqual(['p2']);
  });
});

describe('applyNamingResult', () => {
  it('only updates a product that is still pending, so a user rename wins', async () => {
    vi.resetModules();
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    vi.doMock('../db', () => ({ db: { update: vi.fn(() => ({ set })) } }));
    const { applyNamingResult } = await import('../lib/productRecords');

    await applyNamingResult('t1', 'p1', { name: 'Serum', description: null });

    const sqlText = new PgDialect().sqlToQuery(where.mock.calls[0][0]).sql;
    expect(sqlText).toContain('"naming_status" = $');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'Serum', namingStatus: 'done' }));
  });
});
