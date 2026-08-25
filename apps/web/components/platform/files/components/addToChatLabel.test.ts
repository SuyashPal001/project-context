import { describe, it, expect } from 'vitest';
import { folderChatLabel, groupByAgent, relativeAge } from './AddToChatMenu';
import type { Conversation } from '@/components/platform/chat/types';
import { MAX_FILES_PER_SELECTION } from '@/components/platform/chat/useFileUpload';

// The label is the only place a disabled folder trigger can explain itself —
// disabled buttons do not reliably fire hover, so the tooltip may never show.
describe('folderChatLabel', () => {
    it('names the limit when the folder is over it', () => {
        expect(folderChatLabel(MAX_FILES_PER_SELECTION + 1))
            .toBe(`Over ${MAX_FILES_PER_SELECTION}-file limit`);
    });

    it('says the folder is empty rather than offering a dead action', () => {
        expect(folderChatLabel(0)).toBe('Empty folder');
    });

    it('offers the action at the boundary, not one below it', () => {
        expect(folderChatLabel(MAX_FILES_PER_SELECTION)).toBe('Add to chat');
    });
});

describe('relativeAge', () => {
    it('drops an unparseable date rather than rendering "Invalid Date"', () => {
        expect(relativeAge('not-a-date')).toBe('');
    });

    it('drops a missing date', () => {
        expect(relativeAge(undefined)).toBe('');
    });

    it('describes a real date relative to now', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
        expect(relativeAge(twoHoursAgo)).toBe('about 2 hours ago');
    });
});

const conv = (id: string, agentId: string, agentName: string): Conversation => ({
    id, agentId, tenantId: 't1', title: id, status: 'active',
    createdAt: new Date().toISOString(),
    agent: { id: agentId, name: agentName } as Conversation['agent'],
});

describe('groupByAgent', () => {
    it('collapses repeated agents into one group', () => {
        const groups = groupByAgent([
            conv('a', 'agent-1', 'Scout'),
            conv('b', 'agent-1', 'Scout'),
            conv('c', 'agent-2', 'Rex'),
        ]);
        expect(groups.map(g => g.agentId)).toEqual(['agent-1', 'agent-2']);
        expect(groups[0].conversations.map(c => c.id)).toEqual(['a', 'b']);
    });

    it('orders groups by the newest chat inside them, not by agent name', () => {
        const groups = groupByAgent([
            conv('newest', 'agent-2', 'Rex'),
            conv('older', 'agent-1', 'Scout'),
        ]);
        expect(groups[0].agentId).toBe('agent-2');
    });

    it('keeps a later chat with its group rather than starting a new one', () => {
        const groups = groupByAgent([
            conv('a', 'agent-1', 'Scout'),
            conv('b', 'agent-2', 'Rex'),
            conv('c', 'agent-1', 'Scout'),
        ]);
        expect(groups).toHaveLength(2);
        expect(groups[0].conversations.map(c => c.id)).toEqual(['a', 'c']);
    });
});
