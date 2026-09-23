import { describe, expect, it } from "vitest";
import { selectHyperspaceQuality } from "./quality-tier";

describe("selectHyperspaceQuality", () => {
    it("caps high-quality DPR and plane count", () => {
        expect(selectHyperspaceQuality({ width: 1600, devicePixelRatio: 3, hardwareConcurrency: 10 })).toEqual({
            name: "high",
            planeCount: 72,
            dpr: 1.5,
        });
    });

    it("uses a constrained tier for narrow or low-core devices", () => {
        expect(selectHyperspaceQuality({ width: 620, devicePixelRatio: 2, hardwareConcurrency: 8 })).toEqual({
            name: "low",
            planeCount: 30,
            dpr: 1,
        });
    });

    it("honors reduced motion with the lowest non-video budget", () => {
        expect(selectHyperspaceQuality({ width: 1600, devicePixelRatio: 2, hardwareConcurrency: 10, reducedMotion: true }).name).toBe("low");
    });
});
