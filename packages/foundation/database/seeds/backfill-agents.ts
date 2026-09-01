/**
 * One-time backfill: seeds Saarthi PRD, Saarthi Roadmap, Saarthi Task, and
 * ensures PM Agent & Architect exist for every tenant that was created before
 * these agents were added to the onboarding flow.
 *
 * Usage:
 *   cd packages/foundation/database
 *   DATABASE_URL=... npx tsx seeds/backfill-agents.ts
 */

import { randomBytes, createHash } from 'crypto';
import net from 'net';
import dns from 'dns';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, isNull } from 'drizzle-orm';
import * as schema from '../schema/index';

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

// @ts-ignore — cross-package import; run from repo root with tsx
import { agents } from '../../../../products/agent-platform/packages/schema/agents';
// @ts-ignore
import { agentSkills } from '../../../../products/agent-platform/packages/schema/conversations';
// @ts-ignore
import { apiKeys } from '../schema/access';
// @ts-ignore
import { tenants, memberships } from '../schema/tenancy';
// @ts-ignore
import { roles, rolePermissions, permissions } from '../schema/authorization';

const connectionString = process.env.DATABASE_URL!;
const isNeon = connectionString.includes('.neon.tech');
const client = postgres(connectionString, { max: 1, ...(isNeon && { socket: neonSocket }) });
const db = drizzle(client, { schema });

const generateKey = () => {
    const raw = `ak_${randomBytes(32).toString('hex')}`;
    return { raw, hash: createHash('sha256').update(raw).digest('hex') };
};

const DEFAULT_AGENTS: { name: string; description: string; systemPrompt: string }[] = [
    {
        name: 'PM Agent',
        description: 'PM supervisor that orchestrates PRD generation, roadmap planning, and task breakdown.',
        systemPrompt: 'You are a PM Agent that helps with product planning, PRDs, roadmaps, and task breakdowns.',
    },
    {
        name: 'Architect',
        description: 'Technical architect that answers codebase and system design questions using your knowledge base.',
        systemPrompt: 'You are the technical architect. Always call retrieve_knowledge before answering any technical question about the codebase.',
    },
    {
        name: 'Saarthi PRD',
        description: 'Creates, writes, and refines Product Requirements Documents from your ideas and goals.',
        systemPrompt: 'You are a senior engineering lead specialising in Product Requirements Documents. Create thorough, structured PRDs from user input.',
    },
    {
        name: 'Saarthi Roadmap',
        description: 'Generates roadmaps, project plans, and milestones from an approved PRD.',
        systemPrompt: 'You are a roadmap planning specialist. Break approved PRDs into phased milestones with clear deliverables and timelines.',
    },
    {
        name: 'Saarthi Task',
        description: 'Breaks approved milestones into concrete engineering tasks with acceptance criteria, priorities, and effort estimates.',
        systemPrompt: 'You are a task breakdown specialist. Decompose milestones into well-defined engineering tasks with clear acceptance criteria.',
    },
    {
        name: 'Director',
        description: 'Generates and edits images from a description.',
        systemPrompt: 'You are Director. Generate and edit images from a description.',
    },
];

async function run() {
    const allTenants = await db.select({ id: tenants.id, name: tenants.name }).from(tenants);
    console.log(`Found ${allTenants.length} tenant(s)`);

    // Resolve the agent role's permission strings once — the role is global (not per-tenant).
    const agentRole = (await db.select({ id: roles.id }).from(roles).where(eq(roles.isAgentRole, true)).limit(1))[0];
    const agentRolePermissionRows = agentRole
        ? await db
              .select({ resource: permissions.resource, action: permissions.action })
              .from(rolePermissions)
              .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
              .where(eq(rolePermissions.roleId, agentRole.id))
        : [];
    const agentRolePermissionStrings = agentRolePermissionRows.map((p: { resource: string; action: string }) => `${p.resource}:${p.action}`);

    for (const tenant of allTenants) {
        console.log(`\nProcessing tenant: ${tenant.name} (${tenant.id})`);

        // Find owner userId for this tenant
        const ownerRole = (await db.select({ id: roles.id }).from(roles)
            .where(and(eq(roles.name, 'owner'), isNull(roles.tenantId))).limit(1))[0];

        const ownerMembership = ownerRole
            ? (await db.select({ userId: memberships.userId }).from(memberships)
                .where(and(eq(memberships.tenantId, tenant.id), eq(memberships.roleId, ownerRole.id))).limit(1))[0]
            : null;

        if (!ownerMembership) {
            console.warn(`  No owner found for tenant ${tenant.id}, skipping`);
            continue;
        }
        const userId = ownerMembership.userId;

        // Get existing agent names for this tenant
        const existing = await db.select({ name: agents.name }).from(agents)
            .where(eq(agents.tenantId, tenant.id));
        const existingNames = new Set(existing.map(a => a.name));

        for (const def of DEFAULT_AGENTS) {
            if (existingNames.has(def.name)) {
                console.log(`  ✓ ${def.name} already exists`);
                continue;
            }

            const { hash } = generateKey();
            const [key] = await db.insert(apiKeys).values({
                tenantId: tenant.id,
                name: `${def.name} API Key`,
                type: 'agent',
                keyHash: hash,
                permissions: agentRolePermissionStrings,
                status: 'active',
                createdBy: userId,
            }).returning();

            const [agent] = await db.insert(agents).values({
                tenantId: tenant.id,
                name: def.name,
                type: 'custom',
                status: 'active',
                description: def.description,
                apiKeyId: key.id,
                createdBy: userId,
            }).returning();

            await db.insert(agentSkills).values({
                agentId: agent.id,
                tenantId: tenant.id,
                name: 'default',
                systemPrompt: def.systemPrompt,
                tools: [],
                status: 'active',
            });

            console.log(`  + Created ${def.name}`);
        }
    }

    console.log('\nBackfill complete');
    await client.end();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('Backfill failed:', err);
    await client.end();
    process.exit(1);
});
