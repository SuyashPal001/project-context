/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
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

/** Fires a load event on an <img> with given natural dimensions. */
function loadImageWithSize(img: HTMLImageElement, width: number, height: number) {
    Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
    fireEvent.load(img);
}

/** Fires loadedmetadata on a <video> with given intrinsic dimensions. */
function loadVideoWithSize(video: HTMLVideoElement, width: number, height: number) {
    Object.defineProperty(video, "videoWidth", { value: width, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: height, configurable: true });
    fireEvent.loadedMetadata(video);
}

describe("OfficialSkillDetail", () => {
    it("renders no 'Skill Details' header bar", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.queryByText("Skill Details")).toBeNull();
    });

    it("renders the skill name as a single visible heading, description without a label, and Best-for chips", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.getAllByRole("heading", { name: "Avatar Creator", level: 1 })).toHaveLength(1);
        expect(screen.getByText("Generate a branded avatar from a product photo.")).toBeTruthy();
        expect(screen.getByText("Fitness coaches")).toBeTruthy();
        expect(screen.queryByText("Description")).toBeNull();
    });

    it("wraps Best-for chips inline instead of stacking", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        const chip = screen.getByText("Fitness coaches");
        const chipsContainer = chip.parentElement;
        expect(chipsContainer?.className).toContain("flex-wrap");
    });

    it("renders a close button and a Recreate button", () => {
        renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
        expect(screen.getByRole("button", { name: /close/i })).toBeTruthy();
        expect(screen.getByRole("button", { name: /recreate/i })).toBeTruthy();
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

    describe("image fit", () => {
        it("fills the pane with object-cover and no blurred backdrop for a near-4:5 portrait", () => {
            renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
            const sharpImage = screen.getByAltText("Avatar Creator") as HTMLImageElement;
            loadImageWithSize(sharpImage, 800, 1000);

            expect(sharpImage.className).toContain("object-cover");
            const backdrops = screen.queryAllByRole("presentation", { hidden: true });
            expect(backdrops.find((el) => el.className.includes("blur-2xl"))).toBeUndefined();
        });

        it("uses object-contain plus a blurred backdrop for a landscape image", () => {
            renderWithClient(<OfficialSkillDetail skill={makeSkill()} onOpenChange={vi.fn()} />);
            const sharpImage = screen.getByAltText("Avatar Creator") as HTMLImageElement;
            loadImageWithSize(sharpImage, 1600, 900);

            expect(sharpImage.className).toContain("object-contain");
            const backdrops = screen.queryAllByRole("presentation", { hidden: true });
            expect(backdrops.find((el) => el.className.includes("blur-2xl"))).toBeTruthy();
        });
    });

    describe("video showcase", () => {
        it("renders a video with a poster when showcase.videoUrl is present", () => {
            renderWithClient(
                <OfficialSkillDetail
                    skill={makeSkill({
                        showcase: {
                            imageUrl: "/creative/avatars/beginner-fitness-instructor.jpg",
                            bestFor: ["Fitness coaches"],
                            starterPrompt: "Create an avatar for my fitness brand",
                            videoUrl: "/creative/avatars/demo.mp4",
                        },
                    })}
                    onOpenChange={vi.fn()}
                />,
            );

            const video = document.querySelector("video") as HTMLVideoElement;
            expect(video).toBeTruthy();
            expect(video.getAttribute("poster")).toBe("/creative/avatars/beginner-fitness-instructor.jpg");
            expect(video.autoplay).toBe(true);
            expect(video.loop).toBe(true);
            expect(video.muted).toBe(true);

            loadVideoWithSize(video, 1600, 900);
            expect(video.className).toContain("object-contain");
            const backdrops = screen.queryAllByRole("presentation", { hidden: true });
            expect(backdrops.find((el) => el.className.includes("blur-2xl"))).toBeTruthy();
        });
    });
});
