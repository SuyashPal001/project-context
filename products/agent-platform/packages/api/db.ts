import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import net from 'net';
import dns from 'dns';
import * as foundationSchema from '@serverless-saas/database/schema';
import * as agentSchema from '@serverless-saas/agent-schema';

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

const client = postgres(connectionString, { max: 10, ...(isNeon && { socket: neonSocket }) });

export const db = drizzle(client, { schema });
export type DB = typeof db;
