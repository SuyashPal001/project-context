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
    inputTokens: 4000, outputTokens: 1000,
  };
  const schema = { per_million_tokens_micro: { input: 15_000_000, output: 60_000_000 } };
  const rate = { id: 'rate-1', version: 1, schema };
  // costMicro(schema, {4000, 1000}) = (4000*15e6 + 1000*60e6)/1e6 = 120_000
  const chargeRow = (amountMicro: number) => ({
    rows: [{ amount_micro: String(amountMicro), rate_id: 'rate-1', rate_version: 1, pricing_schema: schema }],
  });

  it('derives the settle write\'s default key from chargeKey, not from taskId directly — an attempt-scoped chargeKey must carry through', async () => {
    // Regression: this default used to be hardcoded as `task:{taskId}:settle`
    // directly, which silently diverged from an explicit chargeKey override
    // once taskChargeKey() started varying the charge key per clarify-and-
    // resume attempt. The read side (the chargeRows query) already correctly
    // scoped by chargeKey; only the write side's default didn't follow it.
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-200_000)) };
    await settleTask(
      { ...baseArgs, chargeKey: 'task:task-1:attempt:1' },
      { isUnlimited, spendCredits, pool: pool as never },
    );
    const call = spendCredits.mock.calls[0][0];
    expect(call.key).toBe('task:task-1:attempt:1:settle');
  });

  it('never touches the pool or spendCredits for an unlimited tenant', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(true);
    const resolveRate = vi.fn();
    const spendCredits = vi.fn();
    const pool = { query: vi.fn() };
    await settleTask(baseArgs, { isUnlimited, resolveRate, spendCredits, pool: pool as never });
    expect(pool.query).not.toHaveBeenCalled();
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('does nothing when no debit row exists for the task (nothing was ever charged)', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn();
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('reads the ORIGINAL charged amount and rate back from the ledger — never from caller-supplied inputs', async () => {
    // This is the regression test for the resume-settle bug: settleTask no
    // longer accepts an `estimateMicro` argument at all, so there is no
    // channel left for a "recomputed from current state" number to leak in.
    // The estimate baseline and the rate used to price actual usage both
    // come from the debit ledger row this test hands back — a mock
    // `resolveRate` that would be called if settleTask fell back to
    // resolving TODAY's active rate is asserted as never called.
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn();
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-240_000)) };
    // 240_000 was the amount actually charged (e.g. for a since-changed step
    // count); actual usage here prices to 120_000 -> delta = 240_000 - 120_000.
    await settleTask(baseArgs, { isUnlimited, resolveRate, spendCredits, pool: pool as never });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("kind = 'debit'"), ['tenant-1', 'task:task-1']);
    expect(resolveRate).not.toHaveBeenCalled();
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(120_000n); // 240_000 (charged) - 120_000 (actual)
    expect(call.rateId).toBe('rate-1');
    expect(call.rateVersion).toBe(1);
  });

  it('skips the round trip entirely when the settle amount is 0n', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn();
    // Charged 120_000; actual also prices to 120_000 -> delta 0n.
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-120_000)) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('settles the shortfall as a negative amount with kind settle when actual exceeds the charged amount', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-50_000)) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.key).toBe('task:task-1:settle');
    expect(call.kind).toBe('settle');
    expect(call.amountMicro).toBe(-70_000n); // 50_000 - 120_000
    expect(call.grantType).toBeNull();
  });

  it('credits back the remainder with grantType refund when actual is under the charged amount', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-200_000)) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(80_000n); // 200_000 - 120_000
    expect(call.grantType).toBe('refund');
    expect(call.expiresAt).toBeNull(); // chargeRow's row carries no expires_at
  });

  it('carries the shortest expiresAt among the original debit\'s grants into a settle refund, per spec section 4', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const soon = '2026-09-01T00:00:00.000Z';
    const later = '2026-12-01T00:00:00.000Z';
    const pool = { query: vi.fn().mockResolvedValueOnce({
      rows: [
        { amount_micro: '-100000', rate_id: 'rate-1', rate_version: 1, pricing_schema: schema, expires_at: later },
        { amount_micro: '-100000', rate_id: 'rate-1', rate_version: 1, pricing_schema: schema, expires_at: soon },
      ],
    }) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(80_000n); // 200_000 - 120_000, grantType refund path
    expect(call.grantType).toBe('refund');
    expect(call.expiresAt).toEqual(new Date(soon));
  });

  it('does not attach an expiresAt to a settle-side debit (actual ran over the charged amount)', async () => {
    // spend_credits() ignores p_expires_at on a negative amount anyway, but
    // this pins that settleTask does not even try to compute one on this path.
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce({
      rows: [{ amount_micro: '-50000', rate_id: 'rate-1', rate_version: 1, pricing_schema: schema, expires_at: '2026-09-01T00:00:00.000Z' }],
    }) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    const call = spendCredits.mock.calls[0][0];
    expect(call.grantType).toBeNull();
    expect(call.expiresAt).toBeNull();
  });

  it('sums multiple debit rows under the same key (one chargeTaskEstimate call can draw from several FIFO grants)', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    const pool = { query: vi.fn().mockResolvedValueOnce({
      rows: [
        { amount_micro: '-30000', rate_id: 'rate-1', rate_version: 1, pricing_schema: schema },
        { amount_micro: '-170000', rate_id: 'rate-1', rate_version: 1, pricing_schema: schema },
      ],
    }) };
    await settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never });
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(80_000n); // (30_000+170_000) - 120_000
  });

  it('falls back to resolving today\'s active rate when the original charge landed with no rate', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const resolveRate = vi.fn().mockResolvedValue(rate);
    const spendCredits = vi.fn().mockResolvedValue(0n);
    // Original charge landed unmetered: 0 micro, no rate_id, no pricing_schema.
    const pool = { query: vi.fn().mockResolvedValueOnce({
      rows: [{ amount_micro: '0', rate_id: null, rate_version: null, pricing_schema: null }],
    }) };
    await settleTask(baseArgs, { isUnlimited, resolveRate, spendCredits, pool: pool as never });
    expect(resolveRate).toHaveBeenCalledWith('llm_tokens', 'gemini-2.5-flash');
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(-120_000n); // 0 (charged) - 120_000 (actual, priced via fallback rate)
    expect(call.rateId).toBe('rate-1');
  });

  it('returns quietly (never throws) when spendCredits rejects', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn().mockRejectedValue(new Error('db down'));
    const pool = { query: vi.fn().mockResolvedValueOnce(chargeRow(-200_000)) };
    await expect(settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never }))
      .resolves.toBeUndefined();
  });

  it('returns quietly (never throws) on a pool error', async () => {
    const { settleTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const spendCredits = vi.fn();
    const pool = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    await expect(settleTask(baseArgs, { isUnlimited, spendCredits, pool: pool as never }))
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
        .mockResolvedValueOnce({ rows: [{ amount_micro: '-100000', expires_at: null }] }),
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
    expect(call.expiresAt).toBeNull();
  });

  it('carries the shortest expiresAt among the drawn grants into the refund, per spec section 4', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const soon = '2026-09-01T00:00:00.000Z';
    const later = '2026-12-01T00:00:00.000Z';
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        // Two grants drawn from: one expiring later, one sooner, plus a
        // never-expiring grant — the never-expiring one must not win.
        .mockResolvedValueOnce({ rows: [
          { amount_micro: '-40000', expires_at: later },
          { amount_micro: '-30000', expires_at: soon },
          { amount_micro: '-30000', expires_at: null },
        ] }),
    };
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });

    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.amountMicro).toBe(100_000n);
    expect(call.expiresAt).toEqual(new Date(soon));
  });

  it('carries a null expiresAt (never expires) only when every drawn grant was permanent', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [
          { amount_micro: '-50000', expires_at: null },
          { amount_micro: '-50000', expires_at: null },
        ] }),
    };
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });

    const call = spendCredits.mock.calls[0][0];
    expect(call.expiresAt).toBeNull();
  });

  it('honors an explicit chargeKey/jobType override (Task 10 document flow), scoping the settled-row check and debit sum to the same namespace', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [{ amount_micro: '-100000', expires_at: null }] }),
    };
    const spendCredits = vi.fn().mockResolvedValue(0n);
    await refundTask(
      { tenantId: 'tenant-1', taskId: 'doc-1', chargeKey: 'document:doc-1', jobType: 'document' },
      { isUnlimited, spendCredits, pool: pool as never },
    );

    // Both reads must key off the override namespace, not the default task:{taskId} one.
    const [, settledParams] = pool.query.mock.calls[0];
    expect(settledParams).toEqual(['tenant-1', 'document:doc-1:settle']);
    const [, debitParams] = pool.query.mock.calls[1];
    expect(debitParams).toEqual(['tenant-1', 'document:doc-1']);

    expect(spendCredits).toHaveBeenCalledTimes(1);
    const call = spendCredits.mock.calls[0][0];
    expect(call.key).toBe('document:doc-1:refund');
    expect(call.jobType).toBe('document');
    expect(call.amountMicro).toBe(100_000n);
  });

  it('skips the refund when a settle already landed under the override chargeKey namespace (no double-adjustment)', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [{ exists: true }] }) };
    const spendCredits = vi.fn();
    await refundTask(
      { tenantId: 'tenant-1', taskId: 'doc-1', chargeKey: 'document:doc-1', jobType: 'document' },
      { isUnlimited, spendCredits, pool: pool as never },
    );
    const [, settledParams] = pool.query.mock.calls[0];
    expect(settledParams).toEqual(['tenant-1', 'document:doc-1:settle']);
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(spendCredits).not.toHaveBeenCalled();
  });

  it('does nothing when nothing was ever charged (net is 0)', async () => {
    const { refundTask } = await import('../credits.js');
    const isUnlimited = vi.fn().mockResolvedValue(false);
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockResolvedValueOnce({ rows: [{ amount_micro: '0', expires_at: null }] }),
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

  it('logs a loud, replay-ready UNREFUNDED CHARGE error when the refund write itself fails', async () => {
    // A dropped debit (debitChatTurn) costs revenue we chose not to chase; a
    // dropped refund is money we owe. The write must still be swallowed (a
    // throwing refund must not break the failure path it runs on) but the
    // log must carry everything a human needs to replay it by hand:
    // tenantId, taskId, the idempotency key, and the amount owed.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { refundTask } = await import('../credits.js');
      const isUnlimited = vi.fn().mockResolvedValue(false);
      const pool = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ exists: false }] })
          .mockResolvedValueOnce({ rows: [{ amount_micro: '-100000', expires_at: null }] }),
      };
      const spendCredits = vi.fn().mockRejectedValue(new Error('connection refused'));
      await refundTask({ tenantId: 'tenant-1', taskId: 'task-1' }, { isUnlimited, spendCredits, pool: pool as never });

      const unrefundedLog = errorSpy.mock.calls.find(call => String(call[0]).includes('UNREFUNDED CHARGE'));
      expect(unrefundedLog).toBeDefined();
      const message = String(unrefundedLog![0]);
      expect(message).toContain('tenant-1');
      expect(message).toContain('task-1');
      expect(message).toContain('task:task-1:refund');
      expect(message).toContain('100000');
    } finally {
      errorSpy.mockRestore();
    }
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

// --- Integration: reproduces the exact scenario the resume-settle bug was
// found in — charge happens in one request, settle happens in a LATER,
// separate request, and something about the task (here: step count) changed
// in between. Proves settleTask reads the amount that was actually charged
// back out of credit_ledger rather than trusting any "current" recomputation.
describe.skipIf(!TEST_DB)('settleTask (integration)', () => {
  const TENANT = '00000000-0000-0000-0000-0000000000d1';
  const TASK_ID = '00000000-0000-0000-0000-00000000ad71';
  const MODEL = 'gemini-2.5-flash';

  let pg: typeof import('pg');
  let pool: import('pg').Pool;

  beforeAll(async () => {
    pg = (await import('pg')).default as unknown as typeof import('pg');
    pool = new pg.Pool({ connectionString: TEST_DB });

    await pool.query(`delete from credit_ledger where tenant_id = $1`, [TENANT]);
    await pool.query(`delete from credit_grants where tenant_id = $1`, [TENANT]);
    await pool.query(`delete from credit_accounts where tenant_id = $1`, [TENANT]);
    await pool.query(
      `insert into tenants (id, name, slug) values ($1, 'credits test', 'credits-test-d1') on conflict (id) do nothing`,
      [TENANT],
    );

    const { grantCredits } = await import('@serverless-saas/credits');
    await grantCredits({ tenantId: TENANT, amountMicro: 5_000_000n, key: 'seed:d1', grantType: 'admin' });
  });

  afterAll(async () => {
    await pool.query(`delete from credit_ledger where tenant_id = $1`, [TENANT]);
    await pool.query(`delete from credit_grants where tenant_id = $1`, [TENANT]);
    await pool.query(`delete from credit_accounts where tenant_id = $1`, [TENANT]);
    await pool.query(`delete from tenants where id = $1`, [TENANT]);
    await pool.end();
  });

  it('settles against the amount actually charged for a 2-step estimate, not a 5-step recomputation made later', async () => {
    const { chargeTaskEstimate, settleTask, estimateTaskMicro } = await import('../credits.js');

    // Submit-time charge: task had 2 steps.
    const estimateForTwoSteps = await estimateTaskMicro(2, MODEL);
    const estimateForFiveSteps = await estimateTaskMicro(5, MODEL);
    expect(estimateForFiveSteps).not.toBe(estimateForTwoSteps); // sanity: the two genuinely differ

    await chargeTaskEstimate({ tenantId: TENANT, taskId: TASK_ID, agentId: TENANT, estimateMicro: estimateForTwoSteps });

    // Between submit and settle (e.g. an approval resume, possibly minutes
    // later), a step was added — task_steps now has 5 rows. A caller that
    // recomputes the "estimate" from the CURRENT step count would get
    // estimateForFiveSteps, not what was actually charged.
    await settleTask({ tenantId: TENANT, taskId: TASK_ID, agentId: TENANT, model: MODEL, inputTokens: 0, outputTokens: 0 });

    const settleRow = await pool.query<{ amount_micro: string }>(
      `select amount_micro from credit_ledger where tenant_id = $1 and idempotency_key = $2`,
      [TENANT, `task:${TASK_ID}:settle`],
    );
    // actual usage priced at 0 (inputTokens/outputTokens both 0) -> full estimate credited back.
    expect(BigInt(settleRow.rows[0].amount_micro)).toBe(estimateForTwoSteps);
    // The buggy recompute-from-current-state value must NOT appear anywhere.
    expect(BigInt(settleRow.rows[0].amount_micro)).not.toBe(estimateForFiveSteps);
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
