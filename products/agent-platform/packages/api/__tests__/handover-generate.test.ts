import { describe, it, expect, vi, beforeEach } from 'vitest';
import { agentTasks } from '@serverless-saas/agent-schema/agents';
import { packItems } from '@serverless-saas/agent-schema/handover';

const dbMock = vi.hoisted(() => ({
    select: vi.fn(),
    insert: vi.fn(),
}));

vi.mock('../db', () => ({ db: dbMock }));

function selectFrom(rowsByTable: Map<unknown, unknown[]>) {
    return () => ({
        from: (table: unknown) => ({
            where: async () => rowsByTable.get(table) ?? [],
        }),
    });
}

describe('generateDeliveredItems', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns 0 and never inserts when the plan has no done tasks', async () => {
        dbMock.select.mockImplementation(selectFrom(new Map([[agentTasks, []]])));

        const { generateDeliveredItems } = await import('../lib/handover-generate');
        const added = await generateDeliveredItems('tenant-1', 'plan-1', 'pack-1', 'section-1');

        expect(added).toBe(0);
        expect(dbMock.insert).not.toHaveBeenCalled();
    });

    it('inserts one pack item per done task not already represented', async () => {
        const doneTasks = [
            { id: 'task-1', title: 'Ship landing page', description: 'Built the marketing site', acceptanceCriteria: [{ text: 'Loads under 2s', checked: true }] },
            { id: 'task-2', title: 'Wire up billing', description: null, acceptanceCriteria: [] },
        ];
        dbMock.select.mockImplementation((cols: unknown) => ({
            from: (table: unknown) => ({
                where: async () => {
                    if (table === agentTasks) return doneTasks;
                    if (table === packItems) {
                        // existing-items lookup vs max-sortOrder lookup share this table
                        const isMaxQuery = cols && typeof cols === 'object' && 'value' in (cols as Record<string, unknown>);
                        return isMaxQuery ? [{ value: null }] : [];
                    }
                    return [];
                },
            }),
        }));
        const inserted: unknown[] = [];
        dbMock.insert.mockImplementation(() => ({
            values: (rows: unknown[]) => { inserted.push(...rows); return Promise.resolve([]); },
        }));

        const { generateDeliveredItems } = await import('../lib/handover-generate');
        const added = await generateDeliveredItems('tenant-1', 'plan-1', 'pack-1', 'section-1');

        expect(added).toBe(2);
        expect(inserted).toHaveLength(2);
        expect(inserted[0]).toMatchObject({ sourceType: 'task', sourceId: 'task-1', title: 'Ship landing page' });
        expect((inserted[0] as { description: string }).description).toContain('Loads under 2s');
    });

    it('skips a task that already has a pack item (additive-only re-sync)', async () => {
        const doneTasks = [
            { id: 'task-1', title: 'Already represented', description: null, acceptanceCriteria: [] },
            { id: 'task-2', title: 'New since last sync', description: null, acceptanceCriteria: [] },
        ];
        dbMock.select.mockImplementation((cols: unknown) => ({
            from: (table: unknown) => ({
                where: async () => {
                    if (table === agentTasks) return doneTasks;
                    if (table === packItems) {
                        const isMaxQuery = cols && typeof cols === 'object' && 'value' in (cols as Record<string, unknown>);
                        return isMaxQuery ? [{ value: 3 }] : [{ sourceId: 'task-1' }];
                    }
                    return [];
                },
            }),
        }));
        const inserted: unknown[] = [];
        dbMock.insert.mockImplementation(() => ({
            values: (rows: unknown[]) => { inserted.push(...rows); return Promise.resolve([]); },
        }));

        const { generateDeliveredItems } = await import('../lib/handover-generate');
        const added = await generateDeliveredItems('tenant-1', 'plan-1', 'pack-1', 'section-1');

        expect(added).toBe(1);
        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ sourceId: 'task-2', sortOrder: 4 });
    });
});
