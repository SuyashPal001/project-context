/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { SkillDetailContent } from "./SkillDetailContent";
import type { Skill } from "./types";

vi.mock("@/components/platform/canvas/MarkdownViewer", () => ({
    MarkdownViewer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

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
        ownerEmail: "ada@example.com",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z",
        installId: null,
        installedVersion: null,
        installed: false,
        latestVersionStatus: "ready",
        failureReason: null,
        runCount: 0,
        downloadCount: 0,
        body: null,
        ...overrides,
    };
}

const noop = () => {};

describe("SkillDetailContent author row", () => {
    it("shows the creator's name", () => {
        render(
            <SkillDetailContent
                skill={makeSkill()}
                isOwner={false}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    });

    it("falls back to the email, then to Unknown, when the name is missing", () => {
        const { unmount } = render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null })}
                isOwner
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("ada@example.com")).toBeTruthy();
        unmount();

        render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null, ownerEmail: null })}
                isOwner={false}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("Unknown")).toBeTruthy();
    });
});

describe("SkillDetailContent runs row", () => {
    it("shows the tenant's run count", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ runCount: 12 })}
                isOwner
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
            />,
        );
        expect(screen.getByText("12")).toBeTruthy();
    });
});
