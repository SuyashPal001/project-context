import { describe, it, expect } from 'vitest';
import { folderChatLabel } from './AddToChatMenu';
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
