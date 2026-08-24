/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillCard } from "./SkillCard";
import type { Skill } from "./types";

afterEach(cleanup);

function makeSkill(overrides: Partial<Skill> = {}): Skill {
    return {
        id: "22222222-2222-4222-8222-222222222222",
        name: "PDF Tools",
        slug: "pdf-tools-abc123",
        description: "Work with PDFs",
        visibility: "public",
        isOfficial: false,
        latestVersion: 2,
        ownerTenantId: "tenant-1",
        ownerName: "Ada Lovelace",
        ownerEmail: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: null,
        installedVersion: null,
        installed: false,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        ...overrides,
    };
}

describe("SkillCard install button", () => {
    it("calls onInstall without also opening the detail modal", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        await userEvent.click(screen.getByRole("button", { name: /install/i }));

        expect(onInstall).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("still opens the detail modal when the card body is clicked", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        await userEvent.click(screen.getByText("Work with PDFs"));

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onInstall).not.toHaveBeenCalled();
    });

    it("hides the install button once the skill is installed", () => {
        render(
            <SkillCard
                skill={makeSkill({ installed: true, installedVersion: 2, installId: "install-1" })}
                onClick={vi.fn()}
                onInstall={vi.fn()}
            />,
        );

        expect(screen.queryByRole("button", { name: /install$/i })).toBeNull();
        expect(screen.getByText("installed")).toBeTruthy();
    });

    it("activates Install via keyboard (Enter) without also opening the detail modal", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        const installButton = screen.getByRole("button", { name: /install/i });
        installButton.focus();
        await userEvent.keyboard("{Enter}");

        expect(onInstall).toHaveBeenCalledTimes(1);
        expect(onClick).not.toHaveBeenCalled();
    });

    it("still opens the detail modal on Enter when the wrapper itself is focused", async () => {
        const onClick = vi.fn();
        const onInstall = vi.fn();
        render(<SkillCard skill={makeSkill()} onClick={onClick} onInstall={onInstall} />);

        const wrapper = screen.getByRole("button", { name: /pdf tools/i });
        wrapper.focus();
        await userEvent.keyboard("{Enter}");

        expect(onClick).toHaveBeenCalledTimes(1);
        expect(onInstall).not.toHaveBeenCalled();
    });
});

describe("SkillCard counts", () => {
    it("renders the real run and download counts", () => {
        render(
            <SkillCard
                skill={makeSkill({ runCount: 12, downloadCount: 340 })}
                onClick={vi.fn()}
                onInstall={vi.fn()}
            />,
        );
        expect(screen.getByText("12 runs")).toBeTruthy();
        expect(screen.getByText("340")).toBeTruthy();
    });

    it("renders zeroes rather than dashes for an untouched skill", () => {
        render(<SkillCard skill={makeSkill()} onClick={vi.fn()} onInstall={vi.fn()} />);
        expect(screen.getByText("0 runs")).toBeTruthy();
    });
});
