import { describe, it, expect } from 'vitest';
import {
    DEFAULT_AVATAR_PARAMS,
    SKIN_COLORS,
    HAIR_COLORS,
    randomizeAvatarParams,
    normalizeAvatarParams,
} from './avatarParams';

describe('DEFAULT_AVATAR_PARAMS', () => {
    it('matches the prototype defaults', () => {
        expect(DEFAULT_AVATAR_PARAMS).toEqual({
            head: 'tall',
            eyes: 'shades',
            accessory: 'cybermohawk',
            mouth: 'goatee',
            skinColor: SKIN_COLORS[0],
            hairColor: HAIR_COLORS[0],
            bgTheme: 'transparent',
        });
    });
});

describe('randomizeAvatarParams', () => {
    it('never randomizes bgTheme (always transparent — not user-choosable)', () => {
        const result = randomizeAvatarParams(() => 0.999);
        expect(result.bgTheme).toBe('transparent');
    });

    it('picks values only from the closed enum sets, deterministically from a fixed rng', () => {
        const result = randomizeAvatarParams(() => 0);
        expect(result).toEqual({
            head: 'tall',
            eyes: 'dots',
            accessory: 'cybermohawk',
            mouth: 'goatee',
            skinColor: SKIN_COLORS[0],
            hairColor: HAIR_COLORS[0],
            bgTheme: 'transparent',
        });
    });

    it('picks the last enum value when rng returns just under 1', () => {
        const result = randomizeAvatarParams(() => 0.999);
        expect(result).toEqual({
            head: 'round',
            eyes: 'eyepatch',
            accessory: 'none',
            mouth: 'none',
            skinColor: SKIN_COLORS[SKIN_COLORS.length - 1],
            hairColor: HAIR_COLORS[HAIR_COLORS.length - 1],
            bgTheme: 'transparent',
        });
    });
});

describe('normalizeAvatarParams', () => {
    it('returns the defaults when given null or undefined', () => {
        expect(normalizeAvatarParams(null)).toEqual(DEFAULT_AVATAR_PARAMS);
        expect(normalizeAvatarParams(undefined)).toEqual(DEFAULT_AVATAR_PARAMS);
    });

    it('passes through a fully valid AvatarParams unchanged (aside from bgTheme)', () => {
        const valid = { ...DEFAULT_AVATAR_PARAMS, head: 'round' as const, bgTheme: 'matrix' as const };
        expect(normalizeAvatarParams(valid)).toEqual({ ...valid, bgTheme: 'transparent' });
    });

    it('forces bgTheme to transparent even for a pre-existing record saved with a themed background', () => {
        const themed = { ...DEFAULT_AVATAR_PARAMS, bgTheme: 'space' as const };
        expect(normalizeAvatarParams(themed).bgTheme).toBe('transparent');
    });

    it('falls back to the default for any missing key', () => {
        const partial = { head: 'round' as const };
        expect(normalizeAvatarParams(partial)).toEqual({ ...DEFAULT_AVATAR_PARAMS, head: 'round' });
    });

    it('falls back to the default for any key holding an unrecognized enum value (e.g. stale/future data)', () => {
        const stale = { ...DEFAULT_AVATAR_PARAMS, eyes: 'laser-beams' as any, accessory: 'top-hat' as any };
        expect(normalizeAvatarParams(stale)).toEqual({ ...DEFAULT_AVATAR_PARAMS, eyes: DEFAULT_AVATAR_PARAMS.eyes, accessory: DEFAULT_AVATAR_PARAMS.accessory });
    });

    it('keeps a valid custom skinColor/hairColor even if not in the curated palette (no enum to fall back on for free hex strings)', () => {
        const custom = { ...DEFAULT_AVATAR_PARAMS, skinColor: '#123456' };
        expect(normalizeAvatarParams(custom).skinColor).toBe('#123456');
    });

    it('rejects a non-hex skinColor/hairColor (e.g. an SVG attribute-breakout payload) and falls back to the default', () => {
        const malicious = {
            ...DEFAULT_AVATAR_PARAMS,
            skinColor: '#000" /><image href=x onerror=alert(1) /><rect fill="#000',
            hairColor: 'javascript:alert(1)',
        };
        const result = normalizeAvatarParams(malicious);
        expect(result.skinColor).toBe(DEFAULT_AVATAR_PARAMS.skinColor);
        expect(result.hairColor).toBe(DEFAULT_AVATAR_PARAMS.hairColor);
    });
});
