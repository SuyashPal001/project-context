import { describe, expect, it } from 'vitest';
import { messageHasDisplayedContent } from './MessageItem';
import type { Message } from './types';

const base: Message = { id: 'p', conversationId: 'c', role: 'assistant', content: '', createdAt: '2026-10-07T00:00:00Z' };

describe('a part of a turn with no text', () => {
    it('still shows when it has steps or made a file', () => {
        expect(messageHasDisplayedContent({ ...base, completedTrace: { elapsedSec: 40, toolCalls: [] } } as Message)).toBe(true);
        expect(messageHasDisplayedContent({ ...base, attachments: [{ id: 'a', fileId: 'clip-1', name: 'Scene 1.mp4', type: 'video/mp4' }] } as Message)).toBe(true);
    });

    it('an empty placeholder still hides', () => {
        expect(messageHasDisplayedContent(base)).toBe(false);
    });
});
