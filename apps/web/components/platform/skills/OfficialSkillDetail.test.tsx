/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OfficialSkillDetail } from "./OfficialSkillDetail";
import type { Skill } from "./types";

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
    useParams: () => ({ tenant: "acme" }),
}));

vi.mock("./startOfficialSkill", () => ({
    startOfficialSkill: vi.fn(),
}));

afterEach(cleanup);

function renderWithClient(ui: React.ReactElement) {
    const client = new QueryClient();
    return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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

describe("OfficialSkillDetail", () => {
    it("renders no 'Skill Details' header bar", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.queryByText("Skill Details")).toBeNull();
    });

    it("renders the skill name, description and Best-for chips", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.getByRole("heading", { name: "Avatar Creator", level: 1 })).toBeTruthy();
        expect(screen.getByText("Generate a branded avatar from a product photo.")).toBeTruthy();
        expect(screen.getByText("Fitness coaches")).toBeTruthy();
    });

    it("renders a Start button", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.getByRole("button", { name: /start/i })).toBeTruthy();
    });

    it("renders a sharp example image and a blurred backdrop copy of it", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        const sharpImage = screen.getByAltText("Avatar Creator");
        expect(sharpImage.className).toContain("object-contain");

        const images = screen.getAllByRole("presentation", { hidden: true });
        const blurred = images.find((img) => img.className.includes("blur-2xl"));
        expect(blurred).toBeTruthy();
    });

    it("does not show models, costs, runs, downloads or versions", () => {
        renderWithClient(
            <OfficialSkillDetail
                skill={makeSkill({ runCount: 5, downloadCount: 20, latestVersion: 3 })}
                onOpenChange={vi.fn()}
            />,
        );
        expect(screen.queryByText(/runs/i)).toBeNull();
        expect(screen.queryByText(/downloads?/i)).toBeNull();
        expect(screen.queryByText("v3")).toBeNull();
        expect(screen.queryByText(/model/i)).toBeNull();
    });

    it("renders nothing when skill is null", () => {
        const { container } = renderWithClient(<OfficialSkillDetail skill={null} onOpenChange={vi.fn()} />);
        expect(container.textContent).toBe("");
    });
});
