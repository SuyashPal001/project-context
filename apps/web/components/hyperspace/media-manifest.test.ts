import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HYPERSPACE_MEDIA, type HyperspaceQuality } from "./media-manifest";

const QUALITY_TIERS: readonly HyperspaceQuality[] = ["high", "medium", "low"];

describe("hyperspace media manifest", () => {
    it("contains unique media IDs and runtime sources", () => {
        const ids = HYPERSPACE_MEDIA.map((item) => item.id);
        const sources = HYPERSPACE_MEDIA.flatMap((item) => (
            QUALITY_TIERS.map((tier) => item.sources[tier].src)
        ));

        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(sources).size).toBe(sources.length);
    });

    it("references valid local files with positive dimensions", () => {
        for (const item of HYPERSPACE_MEDIA) {
            for (const tier of QUALITY_TIERS) {
                const source = item.sources[tier];
                const publicPath = join(process.cwd(), "public", source.src);

                expect(source.width).toBeGreaterThan(0);
                expect(source.height).toBeGreaterThan(0);
                expect(existsSync(publicPath), publicPath).toBe(true);
            }
        }
    });
});
