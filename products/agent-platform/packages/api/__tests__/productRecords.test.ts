import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

vi.mock('../db', () => ({ db: {} }));

import { dropImageless, escapeLike, toProductRecord, PRODUCT_NAME_PLACEHOLDER, productFileName } from '../lib/productRecords';

const baseRow = {
  id: 'p1', tenantId: 't1', name: 'Serum', category: null, description: null, price: null, sourceUrl: null,
  usps: [] as string[], imageFileIds: ['f1', 'f2', 'f3'], namingStatus: 'done' as const, createdBy: null,
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

  it('carries category and usps through from the row', () => {
    const record = toProductRecord({ ...baseRow, category: 'Beauty & Personal Care', usps: ['Cruelty-free', 'Vegan'] }, new Map());
    expect(record.category).toBe('Beauty & Personal Care');
    expect(record.usps).toEqual(['Cruelty-free', 'Vegan']);
  });
});

describe('dropImageless', () => {
  it('hides a product whose image files were all deleted, keeps one with some left', () => {
    const allGone = toProductRecord(baseRow, new Map());
    const oneLeft = toProductRecord({ ...baseRow, id: 'p2' }, new Map([['f2', img('f2')]]));
    expect(dropImageless([allGone, oneLeft]).map(p => p.id)).toEqual(['p2']);
  });
});

describe('listProducts', () => {
  it('keeps a product with no images (manually created, no photo yet) in the list', async () => {
    vi.resetModules();
    const productRow = { ...baseRow, id: 'p1', imageFileIds: [] as string[] };
    // First select() call is the products query (chainable, awaited at the end);
    // the second is loadProductImages' files lookup (awaited directly).
    let selectCalls = 0;
    const chain = { orderBy: () => chain, limit: () => chain, offset: () => Promise.resolve([productRow]) };
    vi.doMock('../db', () => ({
      db: {
        select: vi.fn(() => {
          selectCalls++;
          return selectCalls === 1
            ? { from: () => ({ where: () => chain }) }
            : { from: () => ({ where: () => Promise.resolve([]) }) };
        }),
      },
    }));
    const { listProducts } = await import('../lib/productRecords');
    const result = await listProducts('t1', { limit: 50, offset: 0 });
    expect(result.map(p => p.id)).toEqual(['p1']);
    expect(result[0].images).toEqual([]);
  });
});

describe('applyNamingResult', () => {
  it('only updates a product that is still pending, so a user rename wins', async () => {
    vi.resetModules();
    const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) }));
    const set = vi.fn(() => ({ where }));
    vi.doMock('../db', () => ({ db: { update: vi.fn(() => ({ set })) } }));
    const { applyNamingResult } = await import('../lib/productRecords');

    await applyNamingResult('t1', 'p1', { name: 'Serum', description: null });

    const sqlText = new PgDialect().sqlToQuery(where.mock.calls[0][0]).sql;
    expect(sqlText).toContain('"naming_status" = $');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'Serum', namingStatus: 'done' }));
  });
});

describe('productFileName', () => {
  it('names the main photo after the product and numbers the rest, keeping each extension', () => {
    expect(productFileName('Campus Shoes', 0, 'IMG_1.JPG', 'image/jpeg')).toBe('Campus Shoes.jpg');
    expect(productFileName('Campus Shoes', 1, 'shot.png', 'image/png')).toBe('Campus Shoes (2).png');
  });

  it('falls back to an extension from the mime type when the current name has none', () => {
    expect(productFileName('Serum', 0, 'f5c10d58-8c5c', 'image/webp')).toBe('Serum.webp');
    expect(productFileName('Serum', 0, 'noext', null)).toBe('Serum');
  });

  it('replaces slashes and caps the name at 255 characters, keeping suffix and extension', () => {
    const name = productFileName(`a/b\\${'x'.repeat(400)}`, 2, 'p.jpg', 'image/jpeg');
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.startsWith('a-b-')).toBe(true);
    expect(name.endsWith(' (3).jpg')).toBe(true);
  });

  it('strips control characters and collapses the resulting runs of spaces', () => {
    expect(productFileName('Serum\nNew\tPack', 0, 'a.png', 'image/png')).toBe('Serum New Pack.png');
  });
});

describe('renameProductFiles', () => {
  it('renames each of the tenant\'s files in image order and skips unchanged or missing ones', async () => {
    vi.resetModules();
    const updates: Array<{ set: unknown; where: unknown }> = [];
    const selectWhere = vi.fn().mockResolvedValue([
      { id: 'f2', name: 'b.png', mimeType: 'image/png' },
      { id: 'f1', name: 'Serum.jpg', mimeType: 'image/jpeg' },
    ]);
    vi.doMock('../db', () => ({ db: {
      select: vi.fn(() => ({ from: () => ({ where: selectWhere }) })),
      update: vi.fn(() => ({ set: (set: unknown) => ({ where: (where: unknown) => { updates.push({ set, where }); return Promise.resolve(); } }) })),
    } }));
    const { renameProductFiles } = await import('../lib/productRecords');

    await renameProductFiles('t1', ['f1', 'f2', 'f3'], 'Serum');

    // f1 already has the right name, f3 isn't the tenant's (not returned), so only f2 changes.
    expect(updates).toHaveLength(1);
    expect(updates[0].set).toEqual(expect.objectContaining({ name: 'Serum (2).png' }));
    const whereSql = new PgDialect().sqlToQuery(updates[0].where as never).sql;
    expect(whereSql).toContain('"tenant_id" = $');
  });
});

describe('name wiring', () => {
  function mockDb(opts: { returningRow?: Record<string, unknown> | null; failFileSelect?: boolean }) {
    const fileUpdates: unknown[] = [];
    const productRow = opts.returningRow;
    let selectCalls = 0; // only the first select (the file lookup for renaming) fails
    return {
      fileUpdates,
      db: {
        insert: vi.fn(() => ({ values: () => ({ returning: () => Promise.resolve([productRow]) }) })),
        update: vi.fn(() => ({
          set: (set: Record<string, unknown>) => ({
            where: () => {
              // A files-table rename always sets exactly {name, updatedAt} together
              // (renameProductFiles); a creativeProducts update never sets updatedAt
              // itself (drizzle's $onUpdate handles that), regardless of which
              // fields it touches. That pairing is what tells the two apart here.
              if ('updatedAt' in set) {
                fileUpdates.push(set);
                return Promise.resolve();
              }
              return { returning: () => Promise.resolve(productRow ? [productRow] : []) };
            },
          }),
        })),
        select: vi.fn(() => ({ from: () => ({ where: () => (opts.failFileSelect && selectCalls++ === 0)
          ? Promise.reject(new Error('db down'))
          : Promise.resolve([{ id: 'f1', name: 'x.png', mimeType: 'image/png', size: 3 }]) }) })),
      },
    };
  }
  const row = { id: 'p1', tenantId: 't1', name: 'Serum', category: null, description: null, price: null, sourceUrl: null, usps: [] as string[], imageFileIds: ['f1'], namingStatus: 'done', createdBy: null, createdAt: new Date(0), updatedAt: new Date(0) };

  it('updateProduct renames the photo files when the name changes', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: m.db }));
    const { updateProduct } = await import('../lib/productRecords');
    await updateProduct('t1', 'p1', { name: 'Serum' });
    expect(m.fileUpdates).toEqual([expect.objectContaining({ name: 'Serum.png' })]);
  });

  it('updateProduct still succeeds when renaming the files fails', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: row, failFileSelect: true });
    vi.doMock('../db', () => ({ db: m.db }));
    const { updateProduct } = await import('../lib/productRecords');
    await expect(updateProduct('t1', 'p1', { name: 'Serum' })).resolves.not.toBeNull();
  });

  it('updateProduct sets category, description and usps without touching the name', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: { ...row, category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery'] } });
    vi.doMock('../db', () => ({ db: m.db }));
    const { updateProduct } = await import('../lib/productRecords');
    const result = await updateProduct('t1', 'p1', { category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery'] });
    expect(result).toEqual(expect.objectContaining({ category: 'Electronics', description: 'Wireless earbuds', usps: ['20h battery'] }));
    // No name in the update, so the photo files must not be touched.
    expect(m.fileUpdates).toHaveLength(0);
  });

  it('updateProduct returns null for a product the tenant does not own', async () => {
    vi.resetModules();
    const m = mockDb({ returningRow: null });
    vi.doMock('../db', () => ({ db: m.db }));
    const { updateProduct } = await import('../lib/productRecords');
    await expect(updateProduct('t1', 'missing', { category: 'Electronics' })).resolves.toBeNull();
  });

  it('applyNamingResult renames files only when it actually applied a name', async () => {
    vi.resetModules();
    const applied = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: applied.db }));
    let mod = await import('../lib/productRecords');
    await mod.applyNamingResult('t1', 'p1', { name: 'Serum', description: null });
    expect(applied.fileUpdates).toHaveLength(1);

    vi.resetModules();
    const notPending = mockDb({ returningRow: null });
    vi.doMock('../db', () => ({ db: notPending.db }));
    mod = await import('../lib/productRecords');
    await mod.applyNamingResult('t1', 'p1', { name: 'Serum', description: null });
    await mod.applyNamingResult('t1', 'p1', null);
    expect(notPending.fileUpdates).toHaveLength(0);
  });

  it('createProduct renames files only for an already-named product', async () => {
    vi.resetModules();
    const named = mockDb({ returningRow: row });
    vi.doMock('../db', () => ({ db: named.db }));
    let mod = await import('../lib/productRecords');
    await mod.createProduct({ tenantId: 't1', createdBy: null, name: 'Serum', category: null, description: null, price: null, sourceUrl: null, usps: [], imageFileIds: ['f1'], namingStatus: 'done' });
    expect(named.fileUpdates).toHaveLength(1);

    vi.resetModules();
    const pending = mockDb({ returningRow: { ...row, name: 'Untitled product', namingStatus: 'pending' } });
    vi.doMock('../db', () => ({ db: pending.db }));
    mod = await import('../lib/productRecords');
    await mod.createProduct({ tenantId: 't1', createdBy: null, name: 'Untitled product', category: null, description: null, price: null, sourceUrl: null, usps: [], imageFileIds: ['f1'], namingStatus: 'pending' });
    expect(pending.fileUpdates).toHaveLength(0);
  });
});
