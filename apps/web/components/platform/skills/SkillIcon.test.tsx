/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { OFFICIAL_SKILL_PATTERNS, SkillIcon } from "./SkillIcon";

afterEach(cleanup);

describe("SkillIcon", () => {
    it("renders the same seeded random pattern for a given seed when no pattern prop is passed (default path unchanged)", () => {
        const { container: a } = render(<SkillIcon seed="same-seed" />);
        const { container: b } = render(<SkillIcon seed="same-seed" />);

        expect(a.querySelector("svg")!.innerHTML).toBe(b.querySelector("svg")!.innerHTML);
    });

    it("renders different seeded patterns for different seeds", () => {
        const { container: a } = render(<SkillIcon seed="seed-one" />);
        const { container: b } = render(<SkillIcon seed="seed-two" />);

        expect(a.querySelector("svg")!.innerHTML).not.toBe(b.querySelector("svg")!.innerHTML);
    });

    it("renders the exact hand-designed pattern when one is passed, ignoring the seed", () => {
        const pattern = OFFICIAL_SKILL_PATTERNS["talking-head"];
        const expectedCount = pattern.flat().filter(Boolean).length;

        const { container } = render(<SkillIcon seed="irrelevant" pattern={pattern} />);

        expect(container.querySelectorAll("rect").length).toBe(expectedCount);
    });

    it("has both hand-designed official patterns as valid 5x5 grids", () => {
        for (const pattern of Object.values(OFFICIAL_SKILL_PATTERNS)) {
            expect(pattern.length).toBe(5);
            for (const row of pattern) {
                expect(row.length).toBe(5);
            }
        }
    });
});
