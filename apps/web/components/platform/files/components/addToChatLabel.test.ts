import { describe, it, expect } from 'vitest';
import { folderChatLabel, groupByAgent, messagePreview, relativeAge } from './AddToChatMenu';
import type { Conversation } from '@/components/platform/chat/types';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/components/platform/chat/useFileUpload';

// The label is the only place a disabled folder trigger can explain itself —
// disabled buttons do not reliably fire hover, so the tooltip may never show.
describe('folderChatLabel', () => {
    it('names the limit when the folder is over it', () => {
        expect(folderChatLabel(MAX_ATTACHMENTS_PER_MESSAGE + 1))
            .toBe(`Over ${MAX_ATTACHMENTS_PER_MESSAGE}-file limit`);
    });

    it('says the folder is empty rather than offering a dead action', () => {
        expect(folderChatLabel(0)).toBe('Empty folder');
    });

    it('offers the action at the boundary, not one below it', () => {
        expect(folderChatLabel(MAX_ATTACHMENTS_PER_MESSAGE)).toBe('Add to chat');
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

describe('messagePreview', () => {
    const withLast = (role: string, content: string): Conversation =>
        ({ ...conv('a', 'agent-1', 'Scout'), lastMessage: { role, content, createdAt: '' } });

    it('marks the user side so a preview is not read as the agent speaking', () => {
        expect(messagePreview(withLast('user', 'ship it'))).toBe('You: ship it');
    });

    it('leaves an assistant reply unprefixed', () => {
        expect(messagePreview(withLast('assistant', 'done'))).toBe('done');
    });

    it('yields nothing for a conversation with no messages', () => {
        expect(messagePreview(conv('a', 'agent-1', 'Scout'))).toBe('');
    });

    it('treats a whitespace-only placeholder as no preview', () => {
        expect(messagePreview(withLast('assistant', '   '))).toBe('');
    });
});
