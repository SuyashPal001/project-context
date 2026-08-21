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

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

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
    bgTheme: 'transparent',
};

function pick<T>(arr: T[] | readonly T[], rng: () => number): T {
    return arr[Math.floor(rng() * arr.length)];
}

// bgTheme is always 'transparent' — a solid/gradient background clashes with
// whatever surface the avatar renders on (chat bubbles, cards, dark/light
// theme), so it's not user-choosable and never randomized.
export function randomizeAvatarParams(rng: () => number = Math.random): AvatarParams {
    return {
        head: pick(HEAD_SHAPES, rng),
        eyes: pick(EYE_STYLES, rng),
        accessory: pick(ACCESSORIES, rng),
        mouth: pick(MOUTH_STYLES, rng),
        skinColor: pick(SKIN_COLORS, rng),
        hairColor: pick(HAIR_COLORS, rng),
        bgTheme: 'transparent',
    };
}

export const BACKGROUND_THEMES: BackgroundTheme[] = ['terracotta', 'light', 'space', 'matrix', 'transparent'];

function isOneOf<T>(value: unknown, allowed: readonly T[]): value is T {
    return (allowed as readonly unknown[]).includes(value);
}

// Boundary function for any AvatarParams loaded from outside this module
// (persisted API data, hand-edited rows, a future enum addition landing
// after an agent was saved). Per-key fallback to the default rather than
// throwing, so a stale or partially-missing record always renders something
// openable in the builder instead of crashing it. skinColor/hairColor must
// match a strict 6-digit hex format — these values are interpolated raw
// into SVG fill="..." attributes rendered via dangerouslySetInnerHTML, so
// anything else (including attribute-breakout strings) is rejected here.
export function normalizeAvatarParams(input: Partial<AvatarParams> | null | undefined): AvatarParams {
    if (!input) return DEFAULT_AVATAR_PARAMS;
    return {
        head: isOneOf(input.head, HEAD_SHAPES) ? input.head : DEFAULT_AVATAR_PARAMS.head,
        eyes: isOneOf(input.eyes, EYE_STYLES) ? input.eyes : DEFAULT_AVATAR_PARAMS.eyes,
        accessory: isOneOf(input.accessory, ACCESSORIES) ? input.accessory : DEFAULT_AVATAR_PARAMS.accessory,
        mouth: isOneOf(input.mouth, MOUTH_STYLES) ? input.mouth : DEFAULT_AVATAR_PARAMS.mouth,
        skinColor: typeof input.skinColor === 'string' && HEX_COLOR.test(input.skinColor) ? input.skinColor : DEFAULT_AVATAR_PARAMS.skinColor,
        hairColor: typeof input.hairColor === 'string' && HEX_COLOR.test(input.hairColor) ? input.hairColor : DEFAULT_AVATAR_PARAMS.hairColor,
        // Always transparent, even for a pre-existing record saved with a themed
        // background — there's no user-facing choice for this any more.
        bgTheme: 'transparent',
    };
}
