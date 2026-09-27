import { describe, expect, it } from 'vitest';
import { generatedFolderConversationId, generatedFolderDisplayName } from './generatedFolder';
import type { Conversation } from '@/components/platform/chat/types';

const conv = (id: string, title: string): Conversation => ({
    id, tenantId: 't1', agentId: 'a1', title, status: 'active',
    createdAt: new Date().toISOString(),
});

describe('generatedFolderConversationId', () => {
    it('reads the folder name as a conversation id directly under generated/', () => {
        expect(generatedFolderConversationId('generated/', '170afda9-5dfb-4ed1-abcd')).toBe('170afda9-5dfb-4ed1-abcd');
    });

    it('leaves a non-generated prefix untouched', () => {
        expect(generatedFolderConversationId('', 'my-folder')).toBeNull();
        expect(generatedFolderConversationId('creative-avatars/', 'x')).toBeNull();
    });

    it('does not treat a folder nested inside a generated conversation as one', () => {
        expect(generatedFolderConversationId('generated/170afda9-5dfb-4ed1-abcd/', 'subfolder')).toBeNull();
    });
});

describe('generatedFolderDisplayName', () => {
    const conversations = [conv('c1', 'Q3 roadmap draft'), conv('c2', '')];

    it('resolves the matching conversation\'s title', () => {
        expect(generatedFolderDisplayName('c1', conversations)).toBe('Q3 roadmap draft');
    });

    it('falls back to Untitled for a matched conversation with an empty title', () => {
        expect(generatedFolderDisplayName('c2', conversations)).toBe('Untitled');
    });

    it('returns null when no chat matches, so the caller keeps the raw folder name', () => {
        expect(generatedFolderDisplayName('deleted-chat-id', conversations)).toBeNull();
    });
});
