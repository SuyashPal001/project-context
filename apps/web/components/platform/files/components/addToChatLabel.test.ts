import { describe, it, expect } from 'vitest';
import { folderChatLabel, relativeAge } from './AddToChatMenu';
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
