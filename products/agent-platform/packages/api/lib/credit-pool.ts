import type { CreditPool } from '@serverless-saas/agent-credits';
import { sqlClient } from '../db';

/**
 * `@serverless-saas/agent-credits` was written against the agent
 * orchestrator's node-pg Pool: `query(text, params) => { rows }`. This package
 * uses postgres.js behind Drizzle instead, which returns the row array
 * directly from `client.unsafe(text, params)`.
 *
 * A four-line adapter rather than a second connection pool: the API Lambda is
 * already at `max: 10` against a Supabase pooler, and a refund issued from the
 * watchdog is not worth another set of backends.
 *
 * `unsafe` names the escape hatch from postgres.js's tagged-template
 * interpolation, not an unparameterised query — the `params` array is still
 * bound as $1..$n by the server. The SQL text it receives is a compile-time
 * constant inside the credits package; no caller-supplied string reaches it.
 */
export const creditPool: CreditPool = {
    async query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
        const rows = await sqlClient.unsafe(text, params as never[]);
        return { rows: rows as unknown as R[] };
    },
};
