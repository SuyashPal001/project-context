import type { HyperspaceMediaItem } from "./media-manifest";

export interface TunnelPlaneLayout {
    mediaIndex: number;
    side: -1 | 1;
    segment: number;
    row: number;
    x: number;
    y: number;
    z: number;
    rotationX: number;
    rotationY: number;
    rotationZ: number;
    width: number;
    height: number;
    driftPhase: number;
}

export const TUNNEL_NEAR_LIMIT = 1.5;
export const TUNNEL_DEPTH_SPAN = 84;

const DEPTH_BAYS = [-9, -15.5, -22, -28.5, -35, -41.5, -48, -54.5, -61, -67.5, -74, -80.5];

const WALL_X = 6.35;
const HERO_HEIGHT = 4.5;
const COMPANION_HEIGHT = 2.1;
const PLANES_PER_BAY = 6;

/**
 * Builds paired left/right media walls. Every depth bay contains one hero panel
 * and two smaller companions per side, with a shallow inward yaw that preserves
 * readable imagery while maintaining a strong vanishing corridor.
 */
export function createTunnelLayout(
    media: readonly HyperspaceMediaItem[],
    instanceCount: number,
): TunnelPlaneLayout[] {
    const bayCount = Math.ceil(instanceCount / PLANES_PER_BAY);
    const depthStep = TUNNEL_DEPTH_SPAN / bayCount;
    const heroMediaIndices = media.flatMap((item, index) => item.placement === "hero" ? [index] : []);
    const companionMediaIndices = media.flatMap((item, index) => item.placement === "companion" ? [index] : []);

    return Array.from({ length: instanceCount }, (_, index) => {
        const segment = Math.floor(index / PLANES_PER_BAY);
        const baySlot = index % PLANES_PER_BAY;
        const row = Math.floor(baySlot / 2);
        const side: -1 | 1 = baySlot % 2 === 0 ? -1 : 1;
        const heroOnTop = true;
        const isHero = row === 0;
        const mediaPool = isHero ? heroMediaIndices : companionMediaIndices;
        const mediaPoolIndex = isHero
            ? segment * 2 + (side === 1 ? 1 : 0)
            : segment * 4 + (row - 1) * 2 + (side === 1 ? 1 : 0);
        const mediaIndex = mediaPool[mediaPoolIndex % mediaPool.length] ?? index % media.length;
        const item = media[mediaIndex];
        const height = isHero ? HERO_HEIGHT : COMPANION_HEIGHT;
        const heroY = heroOnTop ? 2.25 : -2.25;
        const companionY = heroOnTop
            ? (row === 1 ? -1 : -3.55)
            : (row === 1 ? 1 : 3.55);

        return {
            mediaIndex,
            side,
            segment,
            row,
            x: side * WALL_X,
            y: isHero ? heroY : companionY,
            z: DEPTH_BAYS[0] - segment * depthStep,
            rotationX: 0,
            rotationY: side * -0.16,
            rotationZ: 0,
            width: height * item.aspectRatio,
            height,
            driftPhase: segment * 1.37 + row * 0.61 + (side === 1 ? 0.31 : 0),
        };
    });
}

export function advanceTunnelDepth(z: number, deltaSeconds: number, speed: number): number {
    const next = z + deltaSeconds * speed;
    if (next <= TUNNEL_NEAR_LIMIT) return next;

    const overshoot = (next - TUNNEL_NEAR_LIMIT) % TUNNEL_DEPTH_SPAN;
    return TUNNEL_NEAR_LIMIT - TUNNEL_DEPTH_SPAN + overshoot;
}

export function getTunnelOpacity(z: number): number {
    const smoothstep = (edge0: number, edge1: number, value: number) => {
        const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
        return t * t * (3 - 2 * t);
    };
    const farFade = smoothstep(-84, -68, z);
    const nearFade = 1 - smoothstep(-5, -0.75, z);
    return Math.max(0, Math.min(1, farFade * nearFade));
}
