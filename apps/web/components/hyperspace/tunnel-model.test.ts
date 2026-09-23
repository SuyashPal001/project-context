import { describe, expect, it } from "vitest";
import { HYPERSPACE_MEDIA } from "./media-manifest";
import {
    advanceTunnelDepth,
    createTunnelLayout,
    getTunnelOpacity,
    TUNNEL_DEPTH_SPAN,
    TUNNEL_NEAR_LIMIT,
} from "./tunnel-model";

describe("tunnel model", () => {
    it("creates deterministic alternating lanes with an open center", () => {
        const first = createTunnelLayout(HYPERSPACE_MEDIA, 72);
        const second = createTunnelLayout(HYPERSPACE_MEDIA, 72);
        expect(first).toEqual(second);
        expect(first).toHaveLength(72);
        expect(first.every((plane) => Math.abs(plane.x) === 6.35)).toBe(true);
        expect(first[0].x).toBeLessThan(0);
        expect(first[1].x).toBeGreaterThan(0);
        expect(new Set(first.map((plane) => plane.segment)).size).toBe(12);
        expect(first[0].z).toBe(first[4].z);
        expect(first[1].z).toBe(first[5].z);
        expect(first[0].height).toBeGreaterThan(first[2].height);
        expect(first[1].height).toBeGreaterThan(first[3].height);
        expect(first.every((plane) => Math.abs(plane.rotationY) === 0.16)).toBe(true);
        expect(first.filter((plane) => plane.row === 0).every((plane) => HYPERSPACE_MEDIA[plane.mediaIndex].placement === "hero")).toBe(true);
        expect(first.filter((plane) => plane.row > 0).every((plane) => HYPERSPACE_MEDIA[plane.mediaIndex].placement === "companion")).toBe(true);
    });

    it("recycles a plane behind the distant field after it passes the camera", () => {
        const next = advanceTunnelDepth(1.4, 1, 2);
        expect(next).toBeCloseTo(3.4 - TUNNEL_DEPTH_SPAN);
    });

    it("stays inside the tunnel after a long suspended-tab delta", () => {
        const next = advanceTunnelDepth(-30, 60 * 60, 7.35);

        expect(next).toBeGreaterThanOrEqual(TUNNEL_NEAR_LIMIT - TUNNEL_DEPTH_SPAN);
        expect(next).toBeLessThanOrEqual(TUNNEL_NEAR_LIMIT);
    });

    it("distributes constrained tiers across the complete recycle span", () => {
        const lowTier = createTunnelLayout(HYPERSPACE_MEDIA, 30);
        const bayDepths = [...new Set(lowTier.map((plane) => plane.z))];
        const expectedStep = TUNNEL_DEPTH_SPAN / bayDepths.length;

        expect(bayDepths).toHaveLength(5);
        for (let index = 1; index < bayDepths.length; index += 1) {
            expect(bayDepths[index - 1] - bayDepths[index]).toBeCloseTo(expectedStep);
        }
    });

    it("fades at both the far and near limits", () => {
        expect(getTunnelOpacity(-90)).toBe(0);
        expect(getTunnelOpacity(-30)).toBe(1);
        expect(getTunnelOpacity(-2)).toBeLessThan(0.5);
        expect(getTunnelOpacity(1)).toBe(0);
    });
});
