import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../schema/index';

import { seedRoles } from './system-roles';
import { seedPermissions } from './permissions';
import { seedRolePermissions } from './role-permissions';
import { seedFeatures } from './features';
import { seedPlanEntitlements } from './plan-entitlements';
import { seedCreditRates } from './credit-rates';
import { seedCreditPacks } from './credit-packs';
import { seedLlmProviders } from './llm-providers';
import { seedNotificationTemplates } from './notification-templates';
import { seedTools } from './tools';

const client = postgres(process.env.DATABASE_URL!, { max: 1 });
export const db = drizzle(client, { schema });

async function run() {
    console.log('running foundation seed');

    await seedRoles(db);
    await seedPermissions(db);
    await seedRolePermissions(db);
    await seedFeatures(db);
    await seedPlanEntitlements(db);
    await seedCreditRates(db);
    await seedCreditPacks(db);
    await seedLlmProviders(db);

    try {
        await seedNotificationTemplates(db);
    } catch (err) {
        console.error('seedNotificationTemplates failed (non-fatal):', err);
    }

    try {
        await seedTools(db);
    } catch (err) {
        console.error('seedTools failed (non-fatal):', err);
    }

    console.log('seed complete');
    await client.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('seed failed', err);
    await client.end();
    process.exit(1);
});