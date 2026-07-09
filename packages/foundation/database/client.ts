import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import net from 'net';
import dns from 'dns';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;
const isNeon = connectionString.includes('.neon.tech');

// GCP VM has no IPv6 routing to AWS. Node.js 22 Happy Eyeballs tries all 6
// Neon addresses (3 IPv4 + 3 IPv6) and ETIMEDOUT before succeeding.
// Return a Promise so postgres.js awaits a fully connected IPv4 socket,
// bypassing the Happy Eyeballs race entirely.
function neonSocket(opts: any): Promise<net.Socket> {
  const hostname = Array.isArray(opts.host) ? opts.host[0] : (opts.host ?? opts.hostname);
  const port = Number(Array.isArray(opts.port) ? opts.port[0] : opts.port) || 5432;

  return new Promise((resolve, reject) => {
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses.length) {
        return reject(err ?? new Error('No IPv4 addresses for ' + hostname));
      }
      const socket = net.connect({ host: addresses[0], port });
      // postgres.js reads socket.host for TLS SNI — set the original hostname so
      // Neon's gateway can route the connection to the correct endpoint.
      (socket as any).host = hostname;
      socket.once('connect', () => resolve(socket));
      socket.once('error', reject);
    });
  });
}

const client = postgres(connectionString, {
  max: 10,
  ...(isNeon && { socket: neonSocket }),
});

export const db = drizzle(client, { schema });
console.log('[db] schema keys registered:', Object.keys((db as any)._.schema || {}));
console.log('[db] query keys:', Object.keys((db as any).query || {}));
export type DB = typeof db;
