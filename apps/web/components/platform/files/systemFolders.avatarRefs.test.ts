import { describe, expect, it } from 'vitest';
import { isSystemFolder, isUpload } from './systemFolders';

describe('avatar-refs in Drive', () => {
    it('treats avatar-refs as a hidden platform folder', () => {
        expect(isSystemFolder('avatar-refs')).toBe(true);
        expect(isUpload('avatar-refs/a1/x-sheet.png')).toBe(false);
    });
});
