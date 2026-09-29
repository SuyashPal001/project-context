/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as rtlRender, screen, within, cleanup, type RenderResult } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { SkillDetailContent } from "./SkillDetailContent";
import type { Skill } from "./types";

vi.mock("@/components/platform/canvas/MarkdownViewer", () => ({
    MarkdownViewer: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));

// SkillFilesPanel calls useQuery even when the query is disabled, so every
// render here needs a QueryClientProvider ancestor.
function render(ui: ReactElement): RenderResult {
    const client = new QueryClient();
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

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
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    });

    it("falls back to the email, then to Unknown, when the name is missing", () => {
        const { unmount } = render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.getByText("ada@example.com")).toBeTruthy();
        unmount();

        render(
            <SkillDetailContent
                skill={makeSkill({ ownerName: null, ownerEmail: null })}
                isOwner={false}
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
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
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.getByText("12")).toBeTruthy();
    });
});

describe("SkillDetailContent files sidebar", () => {
    it("lists every file in the package", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ body: "# PDF Tools" })}
                isOwner
                files={[
                    { fileName: "SKILL.md", size: 900 },
                    { fileName: "scripts/run.py", size: 120 },
                ]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        // "SKILL.md" appears twice: the tree row and the selected-file header.
        expect(screen.getAllByTitle("SKILL.md").length).toBeGreaterThan(0);
        expect(screen.getByText("scripts")).toBeTruthy();
        expect(screen.getByTitle("run.py")).toBeTruthy();
    });

    it("says so when the package has no listed files", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ body: "# PDF Tools" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.getByText("No files")).toBeTruthy();
    });
});

describe("SkillDetailContent test button", () => {
    it("offers Test alongside Uninstall for an installed skill", async () => {
        const onTest = vi.fn();
        render(
            <SkillDetailContent
                skill={makeSkill({ installed: true, installedVersion: 2, installId: "install-1" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={onTest}
                isTesting={false}
            />,
        );

        const button = screen.getByRole("button", { name: "Test in chat" });
        button.click();
        expect(onTest).toHaveBeenCalledTimes(1);
    });

    it("hides Test when the skill is not installed", () => {
        render(
            <SkillDetailContent
                skill={makeSkill()}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={vi.fn()}
                isTesting={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Test in chat" })).toBeNull();
    });
});

describe("SkillDetailContent unpublish/delete button visibility", () => {
    it("shows Publish, hides Unpublish and shows Delete for the owner's private skill", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "private" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.getByRole("button", { name: "Publish" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
        expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    it("shows Unpublish, hides Publish and shows Delete for the owner's public skill", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "public" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
        expect(screen.getByRole("button", { name: "Unpublish" })).toBeTruthy();
        expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy();
    });

    it("hides Publish, Unpublish and Delete for a non-owner viewing a public skill", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "public" })}
                isOwner={false}
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });

    it("hides Unpublish and Delete for an Official skill even when isOwner is (incorrectly) true", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "public", isOfficial: true, ownerTenantId: null })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onTest={noop}
                isTesting={false}
            />,
        );
        expect(screen.queryByRole("button", { name: "Unpublish" })).toBeNull();
        expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    });
});

describe("SkillDetailContent unpublish confirm flow", () => {
    it("asks for confirmation before calling onUnpublish", async () => {
        const user = userEvent.setup();
        const onUnpublish = vi.fn();
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "public" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onUnpublish={onUnpublish}
                onTest={noop}
                isTesting={false}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Unpublish" }));
        expect(onUnpublish).not.toHaveBeenCalled();
        expect(screen.getByText(/People who installed it keep their copy/)).toBeTruthy();

        const dialog = screen.getByRole("alertdialog");
        await user.click(within(dialog).getByRole("button", { name: "Unpublish" }));
        expect(onUnpublish).toHaveBeenCalledTimes(1);
    });
});

describe("SkillDetailContent delete confirm flow", () => {
    it("asks for confirmation before calling onDelete", async () => {
        const user = userEvent.setup();
        const onDelete = vi.fn();
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "private" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onDelete={onDelete}
                onTest={noop}
                isTesting={false}
            />,
        );

        await user.click(screen.getByRole("button", { name: "Delete" }));
        expect(onDelete).not.toHaveBeenCalled();
        expect(screen.getByText("This permanently deletes the skill and its versions.")).toBeTruthy();

        const dialog = screen.getByRole("alertdialog");
        await user.click(within(dialog).getByRole("button", { name: "Delete" }));
        expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it("disables the Delete button and shows a pending label while isDeleting", () => {
        render(
            <SkillDetailContent
                skill={makeSkill({ visibility: "private" })}
                isOwner
                files={[]}
                onInstall={noop}
                onUninstall={noop}
                onPublish={noop}
                onDelete={noop}
                onTest={noop}
                isTesting={false}
                isDeleting
            />,
        );
        const button = screen.getByRole("button", { name: "Deleting…" }) as HTMLButtonElement;
        expect(button).toBeTruthy();
        expect(button.disabled).toBe(true);
    });
});
