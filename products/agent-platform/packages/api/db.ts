import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as foundationSchema from '@serverless-saas/database/schema';
import * as agentSchema from '@serverless-saas/agent-schema';

const schema = { ...foundationSchema, ...agentSchema };
const client = postgres(process.env.DATABASE_URL!, { max: 10 });

export const db = drizzle(client, { schema });
export type DB = typeof db;
