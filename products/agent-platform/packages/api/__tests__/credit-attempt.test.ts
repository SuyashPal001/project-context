import { describe, it, expect, vi } from 'vitest';

// This suite intentionally does NOT reuse the shared setup.ts mock of
// eq/and (which discards their arguments), so real drizzle-orm conditions
// flow into the fake db below — but the fake db itself is still purely
// in-memory (no real driver), matching the rest of this test project's
// convention of mocking at the db boundary.

describe('countTaskRefunds', () => {
    it('returns 0 when there are no refund rows for the task (attempt 0, never refunded)', async () => {
        const { countTaskRefunds } = await import('../lib/credit-attempt');
        const fakeDb = {
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue([{ value: 0 }]),
                }),
            }),
        };
        const result = await countTaskRefunds(fakeDb as never, 'tenant-1', 'task-1');
        expect(result).toBe(0);
    });

    it('returns the count of refund rows when refunds exist', async () => {
        const { countTaskRefunds } = await import('../lib/credit-attempt');
        const fakeDb = {
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue([{ value: 2 }]),
                }),
            }),
        };
        const result = await countTaskRefunds(fakeDb as never, 'tenant-1', 'task-1');
        expect(result).toBe(2);
    });

    it('queries the credit_ledger table, not task_events', async () => {
        const { countTaskRefunds } = await import('../lib/credit-attempt');
        const { creditLedger } = await import('@serverless-saas/database/schema/credits');
        const fromSpy = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([{ value: 0 }]) });
        const fakeDb = { select: vi.fn().mockReturnValue({ from: fromSpy }) };
        await countTaskRefunds(fakeDb as never, 'tenant-1', 'task-1');
        expect(fromSpy).toHaveBeenCalledWith(creditLedger);
    });

    it('filters on tenantId, jobId (taskId), and kind=refund — using real eq/and, not a stubbed-out condition', async () => {
        const { countTaskRefunds } = await import('../lib/credit-attempt');
        const whereSpy = vi.fn().mockResolvedValue([{ value: 0 }]);
        const fakeDb = {
            select: vi.fn().mockReturnValue({
                from: vi.fn().mockReturnValue({ where: whereSpy }),
            }),
        };
        await countTaskRefunds(fakeDb as never, 'tenant-9', 'task-9');
        expect(whereSpy).toHaveBeenCalledTimes(1);
        const condition = whereSpy.mock.calls[0][0];
        // A real drizzle SQL AST (queryChunks alternate raw SQL strings with
        // bound Param objects) — walk it for bound values to prove the three
        // real values flowed through as PARAMETERS, not just appear
        // somewhere in the object graph (which is circular via the table
        // reference, so a plain JSON.stringify can't be used here).
        const boundValues: unknown[] = [];
        const walk = (node: unknown): void => {
            if (!node || typeof node !== 'object') return;
            const value = (node as Record<string, unknown>).value;
            if (typeof value === 'string' && !('queryChunks' in (node as Record<string, unknown>))) {
                boundValues.push(value);
                return;
            }
            const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
            if (Array.isArray(chunks)) for (const c of chunks) walk(c);
        };
        walk(condition);
        expect(boundValues).toEqual(['tenant-9', 'task-9', 'refund']);
    });

    // Integration: real DB, bypassing the fully-mocked drizzle singleton this
    // package's tests otherwise use — a genuine drizzle-orm/node-postgres
    // client against TEST_DATABASE_URL, so this exercises the actual query
    // against the real credit_ledger schema (columns, tenant scoping) rather
    // than a hand-shaped mock.
    describe.skipIf(!process.env.TEST_DATABASE_URL)('countTaskRefunds (integration)', () => {
        const TEST_DB = process.env.TEST_DATABASE_URL!;
        const TENANT_A = '00000000-0000-0000-0000-0000000000f1';
        const TENANT_B = '00000000-0000-0000-0000-0000000000f2';
        const TASK_ID = '00000000-0000-0000-0000-00000000af71';

        it('counts only kind=refund rows for this tenant+task, ignoring debits and other tenants', async () => {
            const pg = (await import('pg')).default;
            const { drizzle } = await import('drizzle-orm/node-postgres');
            const pool = new pg.Pool({ connectionString: TEST_DB });
            const realDb = drizzle(pool);

            try {
                for (const [tenantId, slug] of [[TENANT_A, 'credit-attempt-f1'], [TENANT_B, 'credit-attempt-f2']] as const) {
                    await pool.query(`delete from credit_ledger where tenant_id = $1`, [tenantId]);
                    await pool.query(`delete from credit_grants where tenant_id = $1`, [tenantId]);
                    await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
                    await pool.query(
                        `insert into tenants (id, name, slug) values ($1, 'credit attempt test', $2) on conflict (id) do nothing`,
                        [tenantId, slug],
                    );
                    await pool.query(
                        `insert into credit_accounts (tenant_id, balance_micro) values ($1, 0) on conflict (tenant_id) do nothing`,
                        [tenantId],
                    );
                }

                // Tenant A: 2 refund rows + 1 debit row for TASK_ID.
                await pool.query(
                    `insert into credit_ledger (tenant_id, kind, amount_micro, balance_after_micro, job_id, idempotency_key, seq)
                     values ($1, 'debit', -100000, 0, $2, 'task:t', 0)`,
                    [TENANT_A, TASK_ID],
                );
                await pool.query(
                    `insert into credit_ledger (tenant_id, kind, amount_micro, balance_after_micro, job_id, idempotency_key, seq)
                     values ($1, 'refund', 100000, 0, $2, 'task:t:refund', 0)`,
                    [TENANT_A, TASK_ID],
                );
                await pool.query(
                    `insert into credit_ledger (tenant_id, kind, amount_micro, balance_after_micro, job_id, idempotency_key, seq)
                     values ($1, 'refund', 100000, 0, $2, 'task:t:attempt:1:refund', 0)`,
                    [TENANT_A, TASK_ID],
                );
                // Tenant B: same taskId, one refund row — must not count toward A.
                await pool.query(
                    `insert into credit_ledger (tenant_id, kind, amount_micro, balance_after_micro, job_id, idempotency_key, seq)
                     values ($1, 'refund', 50000, 0, $2, 'task:t:refund', 0)`,
                    [TENANT_B, TASK_ID],
                );

                const { countTaskRefunds } = await import('../lib/credit-attempt');
                const countA = await countTaskRefunds(realDb as never, TENANT_A, TASK_ID);
                expect(countA).toBe(2); // the two refund rows only, not the debit

                const countB = await countTaskRefunds(realDb as never, TENANT_B, TASK_ID);
                expect(countB).toBe(1); // tenant B's own single refund, unaffected by A's count
            } finally {
                for (const tenantId of [TENANT_A, TENANT_B]) {
                    await pool.query(`delete from credit_ledger where tenant_id = $1`, [tenantId]);
                    await pool.query(`delete from credit_grants where tenant_id = $1`, [tenantId]);
                    await pool.query(`delete from credit_accounts where tenant_id = $1`, [tenantId]);
                    await pool.query(`delete from tenants where id = $1`, [tenantId]);
                }
                await pool.end();
            }
        });
    });
});
