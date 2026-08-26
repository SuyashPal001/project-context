import { describe, it, expect } from 'vitest';
import { folderDisplayName } from '@/components/platform/chat/FolderScopeChip';

describe('folderDisplayName', () => {
    it('shows the folder name, not the whole prefix', () => {
        expect(folderDisplayName('projects/2026/new/')).toBe('new');
    });

    it('handles a top-level folder', () => {
        expect(folderDisplayName('new/')).toBe('new');
    });

    it('returns empty for an empty prefix', () => {
        expect(folderDisplayName('')).toBe('');
    });

    // A prefix always ends in "/" by construction — the API rejects one that does
    // not — but a trailing-slash assumption that silently yields "" would render a
    // nameless chip, which reads as a bug rather than a folder.
    it('tolerates a prefix with no trailing slash', () => {
        expect(folderDisplayName('projects/new')).toBe('new');
    });
});
