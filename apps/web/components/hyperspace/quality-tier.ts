import type { HyperspaceQuality } from "./media-manifest";

export interface QualityEnvironment {
    width: number;
    devicePixelRatio: number;
    hardwareConcurrency?: number;
    reducedMotion?: boolean;
}

export interface HyperspaceQualityTier {
    name: HyperspaceQuality;
    planeCount: number;
    dpr: number;
}

export function selectHyperspaceQuality(environment: QualityEnvironment): HyperspaceQualityTier {
    const { width, devicePixelRatio, hardwareConcurrency = 4, reducedMotion = false } = environment;

    if (reducedMotion || width < 720 || hardwareConcurrency <= 4) {
        return { name: "low", planeCount: 30, dpr: 1 };
    }

    if (width < 1180 || hardwareConcurrency <= 6) {
        return { name: "medium", planeCount: 54, dpr: Math.min(devicePixelRatio, 1.25) };
    }

    return { name: "high", planeCount: 72, dpr: Math.min(devicePixelRatio, 1.5) };
}
