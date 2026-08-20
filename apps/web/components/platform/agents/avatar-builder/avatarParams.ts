export type HeadShape = 'tall' | 'round' | 'oval';
export type EyeStyle = 'dots' | 'shades' | 'visor' | 'eyepatch';
export type Accessory =
    | 'cybermohawk' | 'hightop' | 'animespikes' | 'pompadour' | 'curtainbangs'
    | 'topknot' | 'bikerhelmet' | 'bandana' | 'hood' | 'none';
export type MouthStyle = 'goatee' | 'beard' | 'stubble' | 'smile' | 'none';
export type BackgroundTheme = 'terracotta' | 'light' | 'space' | 'matrix' | 'transparent';

export interface AvatarParams {
    head: HeadShape;
    eyes: EyeStyle;
    accessory: Accessory;
    mouth: MouthStyle;
    skinColor: string;
    hairColor: string;
    bgTheme: BackgroundTheme;
}

export const SKIN_COLORS = ['#ffd8a8', '#ffc0ad', '#d97757', '#8d5524', '#00ff66', '#c0c0c0'] as const;
export const HAIR_COLORS = ['#3b233a', '#f08080', '#f7e368', '#ff5577', '#00e5ff', '#18181c', '#a0a0a0', '#8d5524'] as const;

export const HEAD_SHAPES: HeadShape[] = ['tall', 'round', 'oval'];
export const EYE_STYLES: EyeStyle[] = ['dots', 'shades', 'visor', 'eyepatch'];
export const ACCESSORIES: Accessory[] = [
    'cybermohawk', 'hightop', 'animespikes', 'pompadour', 'curtainbangs',
    'topknot', 'bikerhelmet', 'bandana', 'hood', 'none',
];
export const MOUTH_STYLES: MouthStyle[] = ['goatee', 'beard', 'stubble', 'smile', 'none'];

export const DEFAULT_AVATAR_PARAMS: AvatarParams = {
    head: 'tall',
    eyes: 'shades',
    accessory: 'cybermohawk',
    mouth: 'goatee',
    skinColor: SKIN_COLORS[0],
    hairColor: HAIR_COLORS[0],
    bgTheme: 'terracotta',
};

function pick<T>(arr: T[] | readonly T[], rng: () => number): T {
    return arr[Math.floor(rng() * arr.length)];
}

// bgTheme is deliberately never randomized here — the original prototype's
// randomizeCapsule() left the background untouched, and re-rolling it on every
// randomize made the preview feel less like "reroll this character" and more
// like "reroll the whole scene."
export function randomizeAvatarParams(rng: () => number = Math.random): AvatarParams {
    return {
        head: pick(HEAD_SHAPES, rng),
        eyes: pick(EYE_STYLES, rng),
        accessory: pick(ACCESSORIES, rng),
        mouth: pick(MOUTH_STYLES, rng),
        skinColor: pick(SKIN_COLORS, rng),
        hairColor: pick(HAIR_COLORS, rng),
        bgTheme: 'terracotta',
    };
}

const BACKGROUND_THEMES: BackgroundTheme[] = ['terracotta', 'light', 'space', 'matrix', 'transparent'];

function isOneOf<T>(value: unknown, allowed: readonly T[]): value is T {
    return (allowed as readonly unknown[]).includes(value);
}

// Boundary function for any AvatarParams loaded from outside this module
// (persisted API data, hand-edited rows, a future enum addition landing
// after an agent was saved). Per-key fallback to the default rather than
// throwing, so a stale or partially-missing record always renders something
// openable in the builder instead of crashing it. skinColor/hairColor are
// free hex strings (not enums), so any non-empty string passes through —
// there's no "invalid" hex to detect here, only missing.
export function normalizeAvatarParams(input: Partial<AvatarParams> | null | undefined): AvatarParams {
    if (!input) return DEFAULT_AVATAR_PARAMS;
    return {
        head: isOneOf(input.head, HEAD_SHAPES) ? input.head : DEFAULT_AVATAR_PARAMS.head,
        eyes: isOneOf(input.eyes, EYE_STYLES) ? input.eyes : DEFAULT_AVATAR_PARAMS.eyes,
        accessory: isOneOf(input.accessory, ACCESSORIES) ? input.accessory : DEFAULT_AVATAR_PARAMS.accessory,
        mouth: isOneOf(input.mouth, MOUTH_STYLES) ? input.mouth : DEFAULT_AVATAR_PARAMS.mouth,
        skinColor: typeof input.skinColor === 'string' && input.skinColor.length > 0 ? input.skinColor : DEFAULT_AVATAR_PARAMS.skinColor,
        hairColor: typeof input.hairColor === 'string' && input.hairColor.length > 0 ? input.hairColor : DEFAULT_AVATAR_PARAMS.hairColor,
        bgTheme: isOneOf(input.bgTheme, BACKGROUND_THEMES) ? input.bgTheme : DEFAULT_AVATAR_PARAMS.bgTheme,
    };
}
