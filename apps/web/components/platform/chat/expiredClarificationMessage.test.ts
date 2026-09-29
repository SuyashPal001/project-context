import { describe, it, expect } from 'vitest';
import { expiredClarificationMessage } from './expiredClarificationMessage';

const request = {
    questions: [
        { prompt: "What's this avatar for?", options: [{ label: 'Skincare & beauty' }, { label: 'Finance app' }] },
        { prompt: 'What vibe should they have?', options: [{ label: 'Relatable peer (Recommended)' }, { label: 'Trusted expert' }] },
        { prompt: 'Pick logos', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] },
    ],
};

describe('expiredClarificationMessage', () => {
    it('writes one "question — answer" line per answered question', () => {
        expect(expiredClarificationMessage(request, {
            0: { selectedIndex: 0 },
            1: { selectedIndex: 1, freeText: 'but warmer' },
            2: { selectedIndices: [0, 2] },
        })).toBe("What's this avatar for? — Skincare & beauty\nWhat vibe should they have? — Trusted expert — but warmer\nPick logos — A, C");
    });

    it('leaves out skipped and unanswered questions', () => {
        expect(expiredClarificationMessage(request, { 1: { skipped: true }, 2: { freeText: 'only B' } }))
            .toBe('Pick logos — only B');
    });

    it('returns null when nothing was answered', () => {
        expect(expiredClarificationMessage(request, { 0: { skipped: true } })).toBeNull();
    });
});
