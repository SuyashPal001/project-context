import { describe, expect, it, vi } from "vitest";

vi.mock("./startOfficialSkill", () => ({ installOfficialSkill: vi.fn(async () => true) }));

import { createAvatarTarget, resolveSkillsUsed } from "./createAvatarTarget";
import { installOfficialSkill } from "./startOfficialSkill";

describe("createAvatarTarget", () => {
    it("starts the skill that matches the chip, with its own prompt", () => {
        expect(createAvatarTarget("UGC")).toEqual({ slugs: ["ugc-avatar-creator"], prompt: "Create a new avatar for my ads" });
        expect(createAvatarTarget("Animation")).toEqual({ slugs: ["animated-character-creator"], prompt: "Create an animated character for my ads" });
        expect(createAvatarTarget("TVC")).toEqual({ slugs: ["tvc-character-creator"], prompt: "Create a TVC actor for my brand" });
    });

    it("turns on all three avatar skills on All, so the agent asks which kind", () => {
        expect(createAvatarTarget(null).slugs).toEqual(["ugc-avatar-creator", "animated-character-creator", "tvc-character-creator"]);
    });
});

describe("resolveSkillsUsed", () => {
    it("installs every seeded skill and skips unseeded ones", async () => {
        const out = await resolveSkillsUsed([{ id: "a", name: "A" }, undefined, { id: "c", name: "C" }]);
        expect(out).toEqual([{ id: "a", name: "A" }, { id: "c", name: "C" }]);
        expect(installOfficialSkill).toHaveBeenCalledTimes(2);
    });

    it("returns undefined when nothing is seeded and null when an install fails", async () => {
        expect(await resolveSkillsUsed([undefined])).toBeUndefined();
        vi.mocked(installOfficialSkill).mockResolvedValueOnce(false);
        expect(await resolveSkillsUsed([{ id: "a", name: "A" }])).toBeNull();
    });
});
