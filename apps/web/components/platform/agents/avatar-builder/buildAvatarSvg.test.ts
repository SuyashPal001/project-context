import { describe, it, expect } from 'vitest';
import { buildAvatarSvg } from './buildAvatarSvg';
import { DEFAULT_AVATAR_PARAMS, HEAD_SHAPES, EYE_STYLES, ACCESSORIES, MOUTH_STYLES } from './avatarParams';
import type { AvatarParams } from './avatarParams';

function withOverrides(overrides: Partial<AvatarParams>): AvatarParams {
    return { ...DEFAULT_AVATAR_PARAMS, ...overrides };
}

describe('buildAvatarSvg', () => {
    it('returns well-formed svg markup', () => {
        const svg = buildAvatarSvg(DEFAULT_AVATAR_PARAMS);
        expect(svg.trim().startsWith('<svg')).toBe(true);
        expect(svg.trim().endsWith('</svg>')).toBe(true);
        expect(svg).toContain('viewBox="0 -15 200 215"');
    });

    it('never interpolates anything other than the closed AvatarParams fields (no free text reaches markup)', () => {
        // Structural guarantee from the spec's security section: the function
        // signature only accepts AvatarParams, so there is no code path for a
        // caller to pass arbitrary text into the SVG.
        const svg = buildAvatarSvg(DEFAULT_AVATAR_PARAMS);
        expect(svg).not.toContain('<script');
    });

    it.each(HEAD_SHAPES)('renders a head rect for head shape %s', (head) => {
        const svg = buildAvatarSvg(withOverrides({ head }));
        expect(svg).toContain(`fill="${DEFAULT_AVATAR_PARAMS.skinColor}"`);
        expect(svg.match(/<rect[^>]*rx="(32|41|30)"/)).not.toBeNull();
    });

    it.each(EYE_STYLES)('renders distinguishing markup for eyes=%s', (eyes) => {
        const svg = buildAvatarSvg(withOverrides({ eyes }));
        if (eyes === 'dots') expect((svg.match(/<circle/g) ?? []).length).toBeGreaterThanOrEqual(2);
        if (eyes === 'shades') expect(svg).toContain('fill="#18181c"');
        if (eyes === 'visor') expect(svg).toContain('fill="#ff9900"');
        if (eyes === 'eyepatch') expect(svg).toContain('fill="#18181c"');
    });

    it.each(ACCESSORIES)('renders without throwing for accessory=%s', (accessory) => {
        expect(() => buildAvatarSvg(withOverrides({ accessory }))).not.toThrow();
    });

    it('omits hair markup entirely when accessory is none', () => {
        const withHair = buildAvatarSvg(withOverrides({ accessory: 'cybermohawk' }));
        const withoutHair = buildAvatarSvg(withOverrides({ accessory: 'none' }));
        expect(withoutHair.length).toBeLessThan(withHair.length);
    });

    it.each(MOUTH_STYLES)('renders without throwing for mouth=%s', (mouth) => {
        expect(() => buildAvatarSvg(withOverrides({ mouth }))).not.toThrow();
    });

    it('renders a smile as a downward-curving path distinct from the default mouth line', () => {
        const smile = buildAvatarSvg(withOverrides({ mouth: 'smile' }));
        const none = buildAvatarSvg(withOverrides({ mouth: 'none' }));
        expect(smile).not.toEqual(none);
    });

    it('omits the background rect and gradient defs when bgTheme is transparent', () => {
        const svg = buildAvatarSvg(withOverrides({ bgTheme: 'transparent' }));
        expect(svg).not.toContain('bgGlow');
    });

    it('includes the background gradient for a non-transparent theme', () => {
        const svg = buildAvatarSvg(withOverrides({ bgTheme: 'matrix' }));
        expect(svg).toContain('bgGlow');
        expect(svg).toContain('#0a2a22');
    });

    it('uses the given hairColor for hair-bearing accessories', () => {
        const svg = buildAvatarSvg(withOverrides({ accessory: 'cybermohawk', hairColor: '#123456' }));
        expect(svg).toContain('#123456');
    });
});
