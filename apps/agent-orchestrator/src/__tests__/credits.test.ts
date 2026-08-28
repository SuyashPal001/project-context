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

const TEST_DB = process.env.TEST_DATABASE_URL;

describe('estimateTaskMicro', () => {
  it('computes stepCount x AVERAGE_STEP_TOKENS at the resolved rate', async () => {
    const { estimateTaskMicro } = await import('../credits.js');
    const resolveRate = vi.fn().mockResolvedValue({
      id: 'rate-1', version: 1,
      schema: { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } },
    });
    // 2 steps -> 8000 input, 2000 output tokens
    // (8000*15_000_000 + 2000*60_000_000) / 1_000_000 = (120e9 + 120e9)/1e6 = 240_000
    const result = await estimateTaskMicro(2, 'gemini-2.5-flash', { resolveRate });
    expect(resolveRate).toHaveBeenCalledWith('llm_tokens', 'gemini-2.5-flash');
    expect(result).toBe(240_000n);
  });

  it('returns 0n when no rate is configured for the model', async () => {
    const { estimateTaskMicro } = await import('../credits.js');
    const resolveRate = vi.fn().mockResolvedValue(null);
    expect(await estimateTaskMicro(3, 'unknown-model', { resolveRate })).toBe(0n);
  });
});

describe('resolveTaskRate', () => {
  it('returns id/version for the resolved rate', async () => {
    const { resolveTaskRate } = await import('../credits.js');
    const resolveRate = vi.fn().mockResolvedValue({ id: 'rate-9', version: 4, schema: { per_million_tokens_micro: { input: 1, output: 1 } } });
    const result = await resolveTaskRate('gemini-2.5-flash', { resolveRate });
    expect(resolveRate).toHaveBeenCalledWith('llm_tokens', 'gemini-2.5-flash');
    expect(result).toEqual({ id: 'rate-9', version: 4 });
  });

  it('returns null when no rate is configured', async () => {
    const { resolveTaskRate } = await import('../credits.js');
    const resolveRate = vi.fn().mockResolvedValue(null);
    expect(await resolveTaskRate('unknown-model', { resolveRate })).toBeNull();
  });
});

describe('chargeTaskEstimate', () => {
  const baseArgs = {
    tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1',
    estimateMicro: 100_000n, rateId: 'rate-1', rateVersion: 1,
  };

  it('never calls spendCredits for an unlimited tenant', async () => {
    const { chargeTaskEstimate } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(true);
    const spendCredits = vi.fn();
    await chargeTaskEstimate(baseArgs, { isUnlimited, spendCredits });
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('debits the estimate with key task:{taskId} and kind debit for a metered tenant', async () => {
    const { chargeTaskEstimate } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await chargeTaskEstimate(baseArgs, { isUnlimited, spendCredits });
    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.tenantId).toBe('tenant-1');
    expect(call.key).toBe('task:task-1');
    expect(call.kind).toBe('debit');
    expect(call.amountMicro).toBe(-100_000n);
    expect(call.jobId).toBe('task-1');
    expect(call.jobType).toBe('agent_task');
    expect(call.actorId).toBe('agent-1');
    expect(call.actorType).toBe('agent');
  });

  it('lets InsufficientCreditsError from spendCredits propagate uncaught', async () => {
    const { chargeTaskEstimate } = await import('../credits.js');
    const { InsufficientCreditsError } = await import('@serverless-saas/credits');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockRejectedValue(new InsufficientCreditsError());
    await expect(chargeTaskEstimate(baseArgs, { isUnlimited, spendCredits }))
      .rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('honors an explicit key/jobType override (Task 10 document flow)', async () => {
    const { chargeTaskEstimate } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await chargeTaskEstimate({ ...baseArgs, key: 'document:doc-1', jobType: 'document' }, { isUnlimited, spendCredits });
    const call = spendCredits.mock.calls[0][0];
    expect(call.key).toBe('document:doc-1');
    expect(call.jobType).toBe('document');
  });
});

describe('settleAmount', () => {
  it('debits the shortfall when actual exceeds estimate', async () => {
    const { settleAmount } = await import('../credits.js');
    expect(settleAmount({ estimateMicro: 100_000n, actualMicro: 150_000n })).toBe(-50_000n);
  });

  it('credits the remainder when actual is under estimate', async () => {
    const { settleAmount } = await import('../credits.js');
    expect(settleAmount({ estimateMicro: 100_000n, actualMicro: 40_000n })).toBe(60_000n);
  });

  it('writes nothing when they match exactly', async () => {
    const { settleAmount } = await import('../credits.js');
    expect(settleAmount({ estimateMicro: 100_000n, actualMicro: 100_000n })).toBe(0n);
  });
});

describe('settleTask', () => {
  const baseArgs = {
    tenantId: 'tenant-1', taskId: 'task-1', agentId: 'agent-1', model: 'gemini-2.5-flash',
    inputTokens: 4000, outputTokens: 1000, estimateMicro: 100_000n,
  };
  const rate = { id: 'rate-1', version: 1, schema: { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } } };
  // costMicro(rate, {4000, 1000}) = (4000*15e6 + 1000*60e6)/1e6 = 120_000

  it('never calls spendCredits for an unlimited tenant', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(true);
    const resolveRate = vi.fn();
    const spendCredits = vi.fn();
    await settleTask(baseArgs, { isUnlimited, resolveRate, spendCredits });
    expect(resolveRate).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('skips the round trip entirely when the settle amount is 0n', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue(rate);
    const spendCredits = vi.fn();
    // estimateMicro exactly equal to actual (120_000)
    await settleTask({ ...baseArgs, estimateMicro: 120_000n }, { isUnlimited, resolveRate, spendCredits });
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('settles the shortfall as a negative amount with kind settle when actual exceeds estimate', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue(rate);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await settleTask({ ...baseArgs, estimateMicro: 50_000n }, { isUnlimited, resolveRate, spendCredits });
    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.key).toBe('task:task-1:settle');
    expect(call.kind).toBe('settle');
    expect(call.amountMicro).toBe(-70_000n); // 50_000 - 120_000
    expect(call.grantType).toBeNull();
  });

  it('credits back the remainder with grantType refund when actual is under estimate', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue(rate);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await settleTask({ ...baseArgs, estimateMicro: 200_000n }, { isUnlimited, resolveRate, spendCredits });
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(80_000n); // 200_000 - 120_000
    expect(call.grantType).toBe('refund');
  });

  it('returns quietly (never throws) when spendCredits rejects', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue(rate);
    const spendCredits = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(settleTask({ ...baseArgs, estimateMicro: 200_000n }, { isUnlimited, resolveRate, spendCredits }))
      .resolves.toBeUndefined();
  });
});

describe('refundTask', () => {
  it('never calls spendCredits for an unlimited tenant', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(true);
    const pool = { query: vi.fn() };
    const spendCredits = vi.fn();
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });
    expect(pool.query).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('skips refunding when a settle row already exists for the task', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ exists: true }] }) };
    const spendCredits = vi.fn();
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('sums debit rows scoped by tenant_id and refunds the net amount', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [{ total: '-100000' }] }),
    };
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });

    // The debit-sum query must filter by tenant_id, not just idempotency_key.
    const [debitSql, debitParams] = pool.query.mock.calls[1];
    expect(debitSql).toMatch(/tenant_id\s*=\s*\$1/);
    expect(debitSql).toMatch(/kind\s*=\s*'debit'/);
    expect(debitParams).toEqual(['tenant-1', 'task:task-1']);

    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.tenantId).toBe('tenant-1');
    expect(call.key).toBe('task:task-1:refund');
    expect(call.kind).toBe('refund');
    expect(call.grantType).toBe('refund');
    expect(call.amountMicro).toBe(100_000n);
  });

  it('does nothing when nothing was ever charged (net is 0)', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [{ total: '0' }] }),
    };
    const spendCredits = vi.fn();
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('returns quietly (never throws) on a pool error', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const spendCredits = vi.fn();
    await expect(refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never }))
      .resolves.toBeUndefined();
  });
});

// --- Integration: proves the refund query's tenant scoping actually holds
// against the live schema — two tenants sharing the identical taskId string
// (and therefore the identical idempotency_key) must not leak into each
// other's refund. This is the carry-forward fix from migration 0071.
describe.skipIf(!TEST_DB)('refundTask (integration)', () => {
  const TENANT_A = '00000000-0000-0000-0000-0000000000c1';
  const TENANT_B = '00000000-0000-0000-0000-0000000000c2';
  const SHARED_TASK_ID = '00000000-0000-0000-0000-00000000ac71';

  let pg: typeof import('pg');
  let pool: import('pg').Pool;

  beforeAll(async () => {
    pg = (await import('pg')).default as unknown as typeof import('pg');
    pool = new pg.Pool({ connectionString: TEST_DB });

    for (const [tenantId, slug] of [[TENANT_A, 'credits-test-c1'], [TENANT_B, 'credits-test-c2']] as const) {
      await pool.query(`delete from credit_ledger where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_grants where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
      await pool.query(
        `insert into tenants (id, name, slug) values ($1, 'credits test', $2) on conflict (id) do nothing`,
        [tenantId, slug],
      );
    }

    // spend_credits() debits FIFO from live credit_grants, not from
    // credit_accounts.balance_micro directly — seed a real grant via
    // spend_credits' own 'grant' path so there's something for the debit to draw on.
    const { grantCredits } = await import('@serverless-saas/credits');
    await grantCredits({ tenantId: TENANT_A, amountMicro: 1_000_000n, key: 'seed:c1', grantType: 'admin' });
    await grantCredits({ tenantId: TENANT_B, amountMicro: 1_000_000n, key: 'seed:c2', grantType: 'admin' });
  });

  afterAll(async () => {
    for (const tenantId of [TENANT_A, TENANT_B]) {
      await pool.query(`delete from credit_ledger where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_grants where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
      await pool.query(`delete from tenants where id = $1`, [tenantId]);
    }
    await pool.end();
  });

  it('refunds only the calling tenant even though both tenants used the same taskId', async () => {
    const { chargeTaskEstimate, refundTask } = await import('../credits.js');

    // Both tenants charge under the SAME taskId, so the idempotency_key
    // 'task:{taskId}' is identical for both — only tenant_id distinguishes them.
    await chargeTaskEstimate({ tenantId: TENANT_A, taskId: SHARED_TASK_ID, agentId: TENANT_A, estimateMicro: 40_000n });
    await chargeTaskEstimate({ tenantId: TENANT_B, taskId: SHARED_TASK_ID, agentId: TENANT_B, estimateMicro: 90_000n });

    await refundTask({ tenantId: TENANT_A, taskId: SHARED_TASK_ID }, { pool });

    const balA = await pool.query<{ balance_micro: string }>(`select balance_micro from credit_accounts where tenant_id = $1`, [TENANT_A]);
    const balB = await pool.query<{ balance_micro: string }>(`select balance_micro from credit_accounts where tenant_id = $1`, [TENANT_B]);

    // A: charged 1_000_000 - 40_000 = 960_000, refunded 40_000 back -> 1_000_000
    expect(BigInt(balA.rows[0].balance_micro)).toBe(1_000_000n);
    // B: charged 1_000_000 - 90_000 = 910_000, untouched by A's refund
    expect(BigInt(balB.rows[0].balance_micro)).toBe(910_000n);

    const refundRowsB = await pool.query(`select 1 from credit_ledger where tenant_id = $1 and kind = 'refund'`, [TENANT_B]);
    expect(refundRowsB.rows.length).toBe(0);
  });
});

// --- Integration: proves BALANCE_QUERY's joins (subscriptions -> plan_entitlements /
// tenant_feature_overrides on the `credits` feature) actually resolve against the
// real seeded schema, not just against a mocked pool shape.
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
