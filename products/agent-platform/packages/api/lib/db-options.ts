/**
 * Database connection behaviour, resolved from configuration rather than from
 * hardcoded hostnames or port numbers.
 *
 * Two things vary by provider and must not be guessed from a host string:
 *
 * - **TLS chain verification.** node-postgres treats `sslmode=require` as
 *   `verify-full`, unlike libpq. Managed poolers commonly present a chain Node
 *   cannot verify, which throws SELF_SIGNED_CERT_IN_CHAIN. Set
 *   `sslmode=no-verify` in the URL (or `DATABASE_SSL_NO_VERIFY=true`) to keep
 *   TLS on while skipping chain verification.
 *
 * - **Prepared statements.** A transaction pooler hands each statement to a
 *   different backend, so named prepared statements fail with
 *   `prepared statement "sN" already exists` under concurrency. Set
 *   `pgbouncer=true` in the URL (the conventional flag, also used by Prisma) or
 *   `DATABASE_DISABLE_PREPARE=true`.
 *
 * Defaults are the strict, correct-for-a-direct-connection ones: verify the
 * chain, use prepared statements. A deployment that needs otherwise says so in
 * its own configuration.
 */

export interface DbConnectionOptions {
  /** Skip TLS chain verification (TLS itself stays on). */
  sslNoVerify: boolean;
  /** Disable named prepared statements — required behind a transaction pooler. */
  disablePrepare: boolean;
}

function flag(value: string | null | undefined): boolean {
  return value === 'true' || value === '1';
}

export function resolveDbOptions(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
): DbConnectionOptions {
  let params: URLSearchParams;
  try {
    params = new URL(connectionString).searchParams;
  } catch {
    params = new URLSearchParams();
  }

  return {
    sslNoVerify:
      flag(env.DATABASE_SSL_NO_VERIFY) ||
      params.get('sslmode') === 'no-verify',
    disablePrepare:
      flag(env.DATABASE_DISABLE_PREPARE) ||
      flag(params.get('pgbouncer')),
  };
}
