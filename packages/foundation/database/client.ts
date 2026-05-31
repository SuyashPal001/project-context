import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

const client = postgres(connectionString, { max: 10 });
export const db = drizzle(client, { schema });
console.log('[db] schema keys registered:', Object.keys((db as any)._.schema || {}));
console.log('[db] query keys:', Object.keys((db as any).query || {}));
export type DB = typeof db;
