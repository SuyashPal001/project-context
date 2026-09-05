import { describe, it, expect } from 'vitest';
import { getPillIcon } from './pillIcon';
import { Sparkles, Music, FileText } from 'lucide-react';

describe('getPillIcon', () => {
    it('resolves a known icon key', () => {
        expect(getPillIcon('music')).toBe(Music);
    });

    it('resolves another known icon key', () => {
        expect(getPillIcon('file-text')).toBe(FileText);
    });

    it('falls back to Sparkles for an unrecognized key', () => {
        expect(getPillIcon('not-a-real-icon')).toBe(Sparkles);
    });

    it('falls back to Sparkles for null/undefined', () => {
        expect(getPillIcon(null)).toBe(Sparkles);
        expect(getPillIcon(undefined)).toBe(Sparkles);
    });
});
