import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

describe('checkCreditBalance', () => {
  it('denies when the balance is zero or below', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [{ balance_micro: '0', unlimited: false }] }) };
    const { checkCreditBalance } = await import('../credits.js');
    const result = await checkCreditBalance('t1', pool as never);
    expect(result.allowed).toBe(false);
  });

  it('allows an unlimited tenant without gating on balance', async () => {
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

describe('debitChatTurn', () => {
  const baseArgs = {
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    messageId: 'msg-1',
    model: 'gemini-2.5-flash',
    inputTokens: 1000,
    outputTokens: 500,
  };

  it('never calls spendCredits for an unlimited tenant', async () => {
    const { debitChatTurn } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(true);
    const resolveRate = vi.fn();
    const spendCredits = vi.fn();

    await debitChatTurn(baseArgs, { isUnlimited, resolveRate, spendCredits });

    expect(isUnlimited).toHaveBeenCalledWith('tenant-1');
    expect(resolveRate).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('spends credits once with the exact chat debit shape for a metered tenant', async () => {
    const { debitChatTurn } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue({
      id: 'rate-1',
      version: 3,
      schema: { per_million_tokens_micro: { input: 150, output: 600 } },
    });
    const spendCredits = vi.fn().mockResolvedValue(0n);

    await debitChatTurn(baseArgs, { isUnlimited, resolveRate, spendCredits });

    expect(resolveRate).toHaveBeenCalledWith('llm_tokens', 'gemini-2.5-flash');
    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.tenantId).toBe('tenant-1');
    expect(call.key).toBe('chat:msg-1');
    expect(call.kind).toBe('debit');
    expect(call.jobType).toBe('chat_message');
    expect(call.actorId).toBe('agent-1');
    expect(call.actorType).toBe('agent');
    expect(call.rateId).toBe('rate-1');
    expect(call.rateVersion).toBe(3);
    expect(typeof call.amountMicro).toBe('bigint');
    expect(call.amountMicro).toBeLessThan(0n);
  });
});

// --- Integration: proves BALANCE_QUERY's joins (subscriptions -> plan_entitlements /
// tenant_feature_overrides on the `credits` feature) actually resolve against the
// real seeded schema, not just against a mocked pool shape.
const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('checkCreditBalance (integration)', () => {
  const METERED_TENANT = '00000000-0000-0000-0000-0000000000b8';
  const UNLIMITED_TENANT = '00000000-0000-0000-0000-0000000000b9';
  const ZERO_BALANCE_TENANT = '00000000-0000-0000-0000-0000000000ba';

  let pg: typeof import('pg');
  let pool: import('pg').Pool;

  beforeAll(async () => {
    pg = (await import('pg')).default as unknown as typeof import('pg');
    pool = new pg.Pool({ connectionString: TEST_DB });

    for (const [tenantId, slug] of [
      [METERED_TENANT, 'credits-test-b8'],
      [UNLIMITED_TENANT, 'credits-test-b9'],
      [ZERO_BALANCE_TENANT, 'credits-test-ba'],
    ] as const) {
      await pool.query(`delete from subscriptions where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
      await pool.query(
        `insert into tenants (id, name, slug) values ($1, 'credits test', $2) on conflict (id) do nothing`,
        [tenantId, slug],
      );
    }

    // Metered tenant: 'business' plan (seeded credits entitlement is metered,
    // not unlimited) with a real credit_accounts balance.
    await pool.query(`insert into subscriptions (tenant_id, plan, status) values ($1, 'business', 'active')`, [METERED_TENANT]);
    await pool.query(`insert into credit_accounts (tenant_id, balance_micro) values ($1, 5000000)`, [METERED_TENANT]);

    // Unlimited tenant: 'enterprise' plan (seeded credits entitlement has unlimited = true).
    await pool.query(`insert into subscriptions (tenant_id, plan, status) values ($1, 'enterprise', 'active')`, [UNLIMITED_TENANT]);

    // Zero-balance tenant: metered plan, no credit_accounts row at all (COALESCE to 0).
    await pool.query(`insert into subscriptions (tenant_id, plan, status) values ($1, 'business', 'active')`, [ZERO_BALANCE_TENANT]);
  });

  afterAll(async () => {
    for (const tenantId of [METERED_TENANT, UNLIMITED_TENANT, ZERO_BALANCE_TENANT]) {
      await pool.query(`delete from subscriptions where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from tenants where id = $1`, [tenantId]);
    }
    await pool.end();
  });

  it('reads a real balance for a metered tenant on the live schema', async () => {
    const { checkCreditBalance } = await import('../credits.js');
    const result = await checkCreditBalance(METERED_TENANT, pool);
    expect(result).toEqual({ allowed: true, balanceMicro: 5000000n, unlimited: false });
  });

  it('resolves unlimited via the real subscriptions -> plan_entitlements join', async () => {
    const { checkCreditBalance } = await import('../credits.js');
    const result = await checkCreditBalance(UNLIMITED_TENANT, pool);
    expect(result.allowed).toBe(true);
    expect(result.unlimited).toBe(true);
  });

  it('refuses a metered tenant with no credit_accounts row (balance coalesces to 0)', async () => {
    const { checkCreditBalance } = await import('../credits.js');
    const result = await checkCreditBalance(ZERO_BALANCE_TENANT, pool);
    expect(result).toEqual({ allowed: false, balanceMicro: 0n, unlimited: false });
  });
});
