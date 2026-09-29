import { describe, it, expect } from 'vitest';
import { stripIds } from './ToolCallCard';

describe('stripIds', () => {
    it('removes fileId mentions and bare uuids from a delegate label', () => {
        expect(stripIds('The user selected Option 2 (fileId: 5c05b036-90f3-4ce6-8bc1-2f6ade182294) to become their new avatar.'))
            .toBe('The user selected Option 2 to become their new avatar.');
        expect(stripIds('Save 5c05b036-90f3-4ce6-8bc1-2f6ade182294 now')).toBe('Save now');
    });

    it('leaves ordinary text alone', () => {
        expect(stripIds('Generate 4 vertical 3:4 portrait variations')).toBe('Generate 4 vertical 3:4 portrait variations');
    });
});
