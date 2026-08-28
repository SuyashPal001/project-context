import { describe, it, expect, vi } from 'vitest';

describe('checkCreditBalance', () => {
  it('denies when the balance is zero or below', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ balance_micro: '0', unlimited: false }] }) };
    const { checkCreditBalance } = await import('../credits.js');
    const result = await checkCreditBalance('t1', pool as never);
    expect(result.allowed).toBe(false);
  });

  it('allows an unlimited tenant without reading a balance', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ balance_micro: '0', unlimited: true }] }) };
    const { checkCreditBalance } = await import('../credits.js');
    expect((await checkCreditBalance('t1', pool as never)).allowed).toBe(true);
  });

  it('fails CLOSED on a database error - unlike the quota functions it replaces', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const { checkCreditBalance } = await import('../credits.js');
    expect((await checkCreditBalance('t1', pool as never)).allowed).toBe(false);
  });
});
