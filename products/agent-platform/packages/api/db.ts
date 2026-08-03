import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import net from 'net';
import dns from 'dns';
import * as foundationSchema from '@serverless-saas/database/schema';
import * as agentSchema from '@serverless-saas/agent-schema';
import { resolveDbOptions } from './lib/db-options';

const schema = { ...foundationSchema, ...agentSchema };

const connectionString = process.env.DATABASE_URL!;
const isNeon = connectionString.includes('.neon.tech');

function neonSocket(opts: any): Promise<net.Socket> {
  const hostname = Array.isArray(opts.host) ? opts.host[0] : (opts.host ?? opts.hostname);
  const port = Number(Array.isArray(opts.port) ? opts.port[0] : opts.port) || 5432;
  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses?.length) return reject(err ?? new Error('No IPv4 for ' + hostname));
      const socket = net.connect({ host: addresses[0], port });
      (socket as any).host = hostname;
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  });
}

// A transaction pooler hands each statement to a different backend, so
// postgres.js's named prepared statements fail with `prepared statement "sN"
// already exists`. It takes concurrency to surface, so it survives light manual
// testing and appears under real traffic. Driven by configuration
// (`pgbouncer=true` in the URL, or DATABASE_DISABLE_PREPARE) rather than by
// inspecting the port, so a deployment declares its own topology.
const { disablePrepare, sslNoVerify } = resolveDbOptions(connectionString);

const client = postgres(connectionString, {
  max: 10,
  ...(isNeon && { socket: neonSocket }),
  ...(disablePrepare && { prepare: false }),
  ...(sslNoVerify && { ssl: { rejectUnauthorized: false } }),
});

export const db = drizzle(client, { schema });
export type DB = typeof db;
