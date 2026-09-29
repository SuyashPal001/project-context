/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OfficialSkillCard } from "./OfficialSkillCard";
import type { Skill } from "./types";

afterEach(cleanup);

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "33333333-3333-4333-8333-333333333333",
        name: "Avatar Creator",
        slug: "avatar-creator",
        description: "Generate a branded avatar from a product photo.",
        visibility: "public",
        isOfficial: true,
        latestVersion: 1,
        ownerTenantId: null,
        ownerName: null,
        ownerEmail: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        installId: null,
        installedVersion: null,
        installed: false,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        showcase: {
            imageUrl: "/creative/avatars/beginner-fitness-instructor.jpg",
            bestFor: ["Fitness coaches", "Wellness brands"],
            starterPrompt: "Create an avatar for my fitness brand",
        },
        ...overrides,
    };
}

describe("OfficialSkillCard", () => {
    it("renders the pixel icon (no <img>), name, Platform owner line, OFFICIAL badge and description", () => {
        const { container } = render(<OfficialSkillCard skill={makeSkill()} onClick={vi.fn()} onStart={vi.fn()} />);

        expect(container.querySelector("img")).toBeNull();
        expect(container.querySelector("svg")).toBeTruthy();
        expect(screen.getByText("Avatar Creator")).toBeTruthy();
        expect(screen.getByText("Platform")).toBeTruthy();
        expect(screen.getByText("Official")).toBeTruthy();
        expect(screen.getByText("Generate a branded avatar from a product photo.")).toBeTruthy();
    });

    it("shows the full best-for line when there are 2 or fewer tags", () => {
        render(<OfficialSkillCard skill={makeSkill()} onClick={vi.fn()} onStart={vi.fn()} />);

        expect(screen.getByText("Fitness coaches · Wellness brands")).toBeTruthy();
    });

    it("shows the first two best-for tags plus a +N count when there are more than 2", () => {
        render(
            <OfficialSkillCard
                skill={makeSkill({
                    showcase: {
                        imageUrl: "/creative/avatars/beginner-fitness-instructor.jpg",
                        bestFor: ["Product explainers", "Testimonials", "Founder updates"],
                        starterPrompt: "Create an avatar for my fitness brand",
                    },
                })}
                onClick={vi.fn()}
                onStart={vi.fn()}
            />,
        );

        expect(screen.getByText("Product explainers · Testimonials +1")).toBeTruthy();
    });

    it("opens the detail view when the card is clicked", async () => {
        const onClick = vi.fn();
        render(<OfficialSkillCard skill={makeSkill()} onClick={onClick} onStart={vi.fn()} />);

        await userEvent.click(screen.getByRole("button", { name: /avatar creator/i }));

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("opens the detail view via keyboard (Enter)", async () => {
        const onClick = vi.fn();
        render(<OfficialSkillCard skill={makeSkill()} onClick={onClick} onStart={vi.fn()} />);

        const card = screen.getByRole("button", { name: /avatar creator/i });
        card.focus();
        await userEvent.keyboard("{Enter}");

        expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("calls onStart and not onClick when Recreate is clicked", async () => {
        const onClick = vi.fn();
        const onStart = vi.fn();
        render(<OfficialSkillCard skill={makeSkill()} onClick={onClick} onStart={onStart} />);

        await userEvent.click(screen.getByRole("button", { name: /recreate/i }));

        expect(onStart).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("shows a disabled starting state when isStarting is true", () => {
        render(<OfficialSkillCard skill={makeSkill()} onClick={vi.fn()} onStart={vi.fn()} isStarting />);

        expect(screen.queryByRole("button", { name: /recreate/i })).toBeNull();
        const startingButton = screen.getByText("Starting…").closest("button");
        expect(startingButton).toBeTruthy();
        expect((startingButton as HTMLButtonElement).disabled).toBe(true);
    });

    it("has no install button, run/download counts or version badge", () => {
        render(
            <OfficialSkillCard
                skill={makeSkill({ runCount: 5, downloadCount: 20, latestVersion: 3 })}
                onClick={vi.fn()}
                onStart={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: /install/i })).toBeNull();
        expect(screen.queryByText(/runs/)).toBeNull();
        expect(screen.queryByText("v3")).toBeNull();
    });

    it("falls back to the plain community-style card when showcase is missing", () => {
        // OfficialSkillCard is only ever rendered by the caller when showcase is
        // present (the page falls back to <SkillCard> otherwise) — this just
        // guards against a crash if it's ever handed a null showcase anyway.
        render(<OfficialSkillCard skill={makeSkill({ showcase: null })} onClick={vi.fn()} onStart={vi.fn()} />);
        expect(screen.getByText("Avatar Creator")).toBeTruthy();
    });
});
