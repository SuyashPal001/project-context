import { describe, it, expect } from "vitest";
import { seededSkillsUsedFromParams } from "./seededSkill";

describe("seededSkillsUsedFromParams", () => {
    it("returns a skillsUsed entry when both skill and skillName are present", () => {
        const params = new URLSearchParams("prompt=hi&skill=skill-1&skillName=Avatar%20Creator");
        expect(seededSkillsUsedFromParams(params)).toEqual([{ id: "skill-1", name: "Avatar Creator" }]);
    });

    it("returns undefined when skill is missing", () => {
        const params = new URLSearchParams("prompt=hi&skillName=Avatar%20Creator");
        expect(seededSkillsUsedFromParams(params)).toBeUndefined();
    });

    it("returns undefined when skillName is missing", () => {
        const params = new URLSearchParams("prompt=hi&skill=skill-1");
        expect(seededSkillsUsedFromParams(params)).toBeUndefined();
    });

    it("returns undefined when neither param is present", () => {
        const params = new URLSearchParams("prompt=hi");
        expect(seededSkillsUsedFromParams(params)).toBeUndefined();
    });
});
