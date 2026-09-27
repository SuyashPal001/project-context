import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const nameProductMock = vi.fn();
vi.mock('../lib/productNaming', () => ({ nameProduct: (...a: unknown[]) => nameProductMock(...a) }));
vi.mock('../db', () => ({ db: {} }));

import { nameCreatedProduct } from '../lib/nameCreatedProduct';

const pending = { id: 'p1', name: 'Untitled product', description: null, price: null, sourceUrl: null, namingStatus: 'pending' as const, images: [], createdAt: '2026-09-27T00:00:00.000Z' };
const named = { ...pending, name: 'Serum', namingStatus: 'done' as const };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

describe('nameCreatedProduct', () => {
  it('returns the named product when naming finishes within the budget', async () => {
    nameProductMock.mockResolvedValue(named);
    expect(await nameCreatedProduct('t1', pending, 10_000)).toEqual(named);
  });

  // The web proxy aborts at 15 s; naming can take up to 20 s. Past the budget
  // the create must answer with the product still pending (the client's
  // stale-pending retry finishes it) rather than time out into an error.
  it('returns the product still pending when naming outlasts the budget', async () => {
    vi.useFakeTimers();
    nameProductMock.mockReturnValue(new Promise(() => {}));
    const result = nameCreatedProduct('t1', pending, 10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(pending);
  });

  it('skips naming when too little budget is left', async () => {
    expect(await nameCreatedProduct('t1', pending, 1_500)).toEqual(pending);
    expect(nameProductMock).not.toHaveBeenCalled();
  });

  it('does not name a product that is not pending', async () => {
    expect(await nameCreatedProduct('t1', named, 10_000)).toEqual(named);
    expect(nameProductMock).not.toHaveBeenCalled();
  });

  it('returns the product as created when naming throws', async () => {
    nameProductMock.mockRejectedValue(new Error('db blip'));
    expect(await nameCreatedProduct('t1', pending, 10_000)).toEqual(pending);
  });
});
