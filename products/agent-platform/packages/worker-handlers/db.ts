import * as foundationSchema from '@serverless-saas/database/schema';
import * as agentSchema from '@serverless-saas/agent-schema';

const schema = { ...foundationSchema, ...agentSchema };

const connectionString = process.env.DATABASE_URL!;

function createDb() {
  if (connectionString.includes('neon.tech')) {
    const { neon } = require('@neondatabase/serverless');
    const { drizzle } = require('drizzle-orm/neon-http');
    const sql = neon(connectionString);
    return drizzle(sql, { schema });
  } else {
    const postgres = require('postgres');
    const { drizzle } = require('drizzle-orm/postgres-js');
    const client = postgres(connectionString, { max: 10 });
    return drizzle(client, { schema });
  }
}

export const db = createDb();
export type DB = typeof db;
