/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateSkillDialog } from "./CreateSkillDialog";

afterEach(cleanup);

const generateSkillMock = vi.hoisted(() => vi.fn());
const createSkillFromBodyMock = vi.hoisted(() => vi.fn());
vi.mock("./generateSkill", async () => {
    const actual = await vi.importActual<typeof import("./generateSkill")>("./generateSkill");
    return { ...actual, generateSkill: generateSkillMock };
});
vi.mock("./actions", () => ({ createSkillFromBody: createSkillFromBodyMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DRAFT = "---\nname: bid-writer\ndescription: Writes bids\n---\n\nAlways open with the client name.";

function renderDialog(onCreated = vi.fn()) {
    return render(<CreateSkillDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);
}

describe("CreateSkillDialog", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        generateSkillMock.mockImplementation(async (_input, { onDelta }) => { onDelta(DRAFT); return DRAFT; });
    });

    it("will not generate without a name and a brief", async () => {
        renderDialog();
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));
        expect(generateSkillMock).not.toHaveBeenCalled();
    });

    it("generates from the brief and shows the draft", async () => {
        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), "Bid Writer");
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), "Help write RFP responses");
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));

        await waitFor(() => expect(screen.getByText(/always open with the client name/i)).toBeTruthy());
        expect(generateSkillMock).toHaveBeenCalledWith(
            expect.objectContaining({ name: "Bid Writer", brief: "Help write RFP responses" }),
            expect.anything(),
        );
    });

    it("saves the generated draft and reports back", async () => {
        const onCreated = vi.fn();
        renderDialog(onCreated);
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), "Bid Writer");
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), "Help write RFP responses");
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));
        await waitFor(() => screen.getByRole("button", { name: /save skill/i }));
        await userEvent.click(screen.getByRole("button", { name: /save skill/i }));

        await waitFor(() => expect(createSkillFromBodyMock).toHaveBeenCalledWith("Bid Writer", "", DRAFT));
        expect(onCreated).toHaveBeenCalled();
    });

    it("sends the previous draft when regenerating with feedback", async () => {
        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), "Bid Writer");
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), "Help write RFP responses");
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));
        await waitFor(() => screen.getByRole("button", { name: /regenerate/i }));

        // The same button first reveals the feedback field, then (on a second
        // click) fires the regeneration — its label never changes, so we query
        // it once and click it twice rather than expecting two distinct labels.
        const regenerateButton = screen.getByRole("button", { name: /regenerate/i });
        await userEvent.click(regenerateButton);
        await userEvent.type(screen.getByPlaceholderText(/what should change/i), "Make it shorter");
        await userEvent.click(regenerateButton);

        await waitFor(() => expect(generateSkillMock).toHaveBeenCalledTimes(2));
        expect(generateSkillMock.mock.calls[1][0]).toMatchObject({ previousDraft: DRAFT, feedback: "Make it shorter" });
    });

    // A failed regenerate must leave the user where they were with the previous
    // draft still intact — not collapsed back to the empty first-generation
    // state, which would silently drop the salvaged draft and typed feedback.
    it("keeps the previous draft and controls when a regenerate fails", async () => {
        const { SkillGenerationError } = await import("./generateSkill");
        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), "Bid Writer");
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), "Help write RFP responses");
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));
        await waitFor(() => screen.getByRole("button", { name: /regenerate/i }));

        const regenerateButton = screen.getByRole("button", { name: /regenerate/i });
        await userEvent.click(regenerateButton);
        await userEvent.type(screen.getByPlaceholderText(/what should change/i), "Make it shorter");

        generateSkillMock.mockRejectedValueOnce(new SkillGenerationError("Generation failed. Try again.", "FAILED"));
        await userEvent.click(regenerateButton);

        await waitFor(() => expect(screen.getByText(/generation failed/i)).toBeTruthy());
        // The previous draft is still on screen and the Regenerate/Save controls
        // are still there — the dialog did not collapse back to the single
        // "Generate" first-run state.
        expect(screen.getByText(/always open with the client name/i)).toBeTruthy();
        expect(screen.getByRole("button", { name: /save skill/i })).toBeTruthy();
        const stillThereRegenerate = screen.getByRole("button", { name: /regenerate/i });
        expect((stillThereRegenerate as HTMLButtonElement).disabled).toBe(false);

        // A follow-up regenerate must still carry the previous draft and the
        // feedback the user already typed, not start a fresh first-generation.
        await userEvent.click(stillThereRegenerate);
        await waitFor(() => expect(generateSkillMock).toHaveBeenCalledTimes(3));
        expect(generateSkillMock.mock.calls[2][0]).toMatchObject({ previousDraft: DRAFT, feedback: "Make it shorter" });
    });

    // A failed generation must leave the user where they were, with their brief
    // intact — not on an empty preview with nothing to retry from.
    it("shows the error and keeps the draft retryable when generation fails", async () => {
        const { SkillGenerationError } = await import("./generateSkill");
        generateSkillMock.mockRejectedValue(new SkillGenerationError("Not enough credits to generate a skill.", "NO_CREDITS"));

        renderDialog();
        await userEvent.type(screen.getByPlaceholderText(/skill name/i), "Bid Writer");
        await userEvent.type(screen.getByPlaceholderText(/what should this skill/i), "Help write RFP responses");
        await userEvent.click(screen.getByRole("button", { name: /generate/i }));

        await waitFor(() => expect(screen.getByText(/not enough credits/i)).toBeTruthy());
        const generateButton = screen.getByRole("button", { name: /generate/i }) as HTMLButtonElement;
        expect(generateButton.disabled).toBe(false);
    });
});
