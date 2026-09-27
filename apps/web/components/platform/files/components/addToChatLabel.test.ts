import { describe, it, expect } from 'vitest';
import { folderChatLabel, groupByAgent, messagePreview, relativeAge, showsEmptyChatList, splitSourceConversation } from './AddToChatMenu';
import type { Conversation } from '@/components/platform/chat/types';
import { MAX_ATTACHMENTS_PER_MESSAGE } from '@/components/platform/chat/useFileUpload';

// The label is the only place a disabled folder trigger can explain itself —
// disabled buttons do not reliably fire hover, so the tooltip may never show.
// Only an empty folder is disabled now: a folder is granted rather than
// attached, so the per-message attachment cap no longer applies to it.
describe('folderChatLabel', () => {
    it('says the folder is empty rather than offering a dead action', () => {
        expect(folderChatLabel(0)).toBe('Empty folder');
    });

    it('offers the action for a folder far larger than the attachment cap', () => {
        expect(folderChatLabel(MAX_ATTACHMENTS_PER_MESSAGE * 10)).toBe('Add to chat');
    });

    it('offers the action at the old boundary', () => {
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

// splitSourceConversation only ever sees the already-active-filtered list (the
// component filters before calling it), so "inactive" here means the source
// chat isn't in that list at all — same shape as one that was deleted.
describe('splitSourceConversation', () => {
    const active = [conv('a', 'agent-1', 'Scout'), conv('b', 'agent-1', 'Scout'), conv('c', 'agent-2', 'Rex')];

    it('pulls the source chat out to the front and excludes it from the rest', () => {
        const { pinned, rest } = splitSourceConversation(active, 'b');
        expect(pinned?.id).toBe('b');
        expect(rest.map(c => c.id)).toEqual(['a', 'c']);
    });

    it('pins nothing when no source id is given', () => {
        const { pinned, rest } = splitSourceConversation(active, undefined);
        expect(pinned).toBeNull();
        expect(rest).toBe(active);
    });

    it('pins nothing when the source chat is missing from the active list (archived or deleted)', () => {
        const { pinned, rest } = splitSourceConversation(active, 'not-in-the-list');
        expect(pinned).toBeNull();
        expect(rest).toEqual(active);
    });
});

// The pinned "Created here" row already tells you a chat exists, so
// "No chats yet." right under it would be contradicting the row a line up.
// That situation is exactly: the source chat is the tenant's only active one.
describe('showsEmptyChatList', () => {
    it('hides the empty-state line when the pinned row is the only chat and there is no search', () => {
        expect(showsEmptyChatList(0, true, false)).toBe(false);
    });

    it('shows the empty-state line once a search is typed, even with a pinned row', () => {
        expect(showsEmptyChatList(0, true, true)).toBe(true);
    });

    it('shows the empty-state line when there is no pinned row at all', () => {
        expect(showsEmptyChatList(0, false, false)).toBe(true);
    });

    it('never shows the empty-state line while chats are matching', () => {
        expect(showsEmptyChatList(3, false, false)).toBe(false);
        expect(showsEmptyChatList(3, true, true)).toBe(false);
    });
});
