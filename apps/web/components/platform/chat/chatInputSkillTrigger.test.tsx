/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Skill } from '@/components/platform/skills/types';

// Same rationale as chatInputAllowMode.test.tsx: ChatInput drags in uploads and
// audio recording on mount, neither of which matters for the trigger routing.
vi.mock('./useFileUpload', () => ({
    MAX_FILES_PER_SELECTION: 5,
    MAX_ATTACHMENTS_PER_MESSAGE: 20,
    useFileUpload: () => ({
        attachments: [], pendingUpload: null, isUploading: false,
        removeAttachment: vi.fn(), addAttachment: vi.fn(), addAttachments: vi.fn(),
        handleFileChange: vi.fn(), uploadFile: vi.fn(), uploadAudio: vi.fn(),
        clearAttachments: vi.fn(),
    }),
}));
vi.mock('./useAudioRecorder', () => ({
    useAudioRecorder: () => ({
        isRecording: false, audioPreview: null, startRecording: vi.fn(),
        stopRecording: vi.fn(), clearPreview: vi.fn(),
    }),
}));
vi.mock('@/lib/pendingAttachments', () => ({ consumePendingAttachments: () => [] }));

// Stand-ins that mark which palette opened, and give the "/" one a way to fire
// a selection without depending on its internals (covered in slashPalette.test).
const SKILL: Skill = {
    id: 'skill-1', name: 'Blog Formatter', slug: 'blog-formatter',
    description: null, visibility: 'private', isOfficial: false, latestVersion: 1,
    ownerTenantId: 't1', ownerName: null, ownerEmail: null,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    installId: 'install-1', installedVersion: 1, installed: true,
    latestVersionStatus: 'ready', failureReason: null, runCount: 0, downloadCount: 0,
};
vi.mock('./SlashPalette', () => ({
    SlashPalette: ({ onSelect }: { onSelect: (s: Skill) => void }) => (
        <button type="button" onClick={() => onSelect(SKILL)}>slash-palette</button>
    ),
}));
vi.mock('./MentionPalette', () => ({
    MentionPalette: ({ onSwitchToSlash }: { onSwitchToSlash?: () => void }) => (
        <div>
            mention-palette
            {onSwitchToSlash && <button type="button" onClick={onSwitchToSlash}>slash-cross-hint</button>}
        </div>
    ),
}));
vi.mock('./HashFilePalette', () => ({ HashFilePalette: () => <div>hash-palette</div> }));

const attachSkillToAgent = vi.fn();
vi.mock('@/components/platform/skills/actions', () => ({
    attachSkillToAgent: (...args: unknown[]) => attachSkillToAgent(...args),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m), info: vi.fn() } }));

import { ChatInput } from './ChatInput';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

// "Use skill" lives inside the "+" dropdown, which has to be opened first.
async function openAddMenu() {
    await userEvent.click(screen.getByLabelText('Add context'));
}

async function type(text: string) {
    const box = screen.getByPlaceholderText(/Ask anything/);
    await userEvent.type(box, text);
    return box;
}

describe('ChatInput trigger routing', () => {
    it('opens the skill palette on "/"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/');
        expect(screen.getByText('slash-palette')).toBeTruthy();
        expect(screen.queryByText('mention-palette')).toBeNull();
    });

    it('opens the employee palette on "@"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('@');
        expect(screen.getByText('mention-palette')).toBeTruthy();
        expect(screen.queryByText('slash-palette')).toBeNull();
    });

    it('opens the file palette on "#"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('#');
        expect(screen.getByText('hash-palette')).toBeTruthy();
    });

    // The public widget renders this same composer without an agentId. Opening
    // "/" there would list the tenant's skill library to an embedded visitor.
    it('does not open the skill palette without an agentId', async () => {
        render(<ChatInput onSend={vi.fn()} />);
        await type('/');
        expect(screen.queryByText('slash-palette')).toBeNull();
    });

    it('still opens the employee palette without an agentId', async () => {
        render(<ChatInput onSend={vi.fn()} />);
        await type('@');
        expect(screen.getByText('mention-palette')).toBeTruthy();
    });

    it('advertises "/" only when there is an agent to attach to', () => {
        const { rerender } = render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        expect(screen.getByPlaceholderText(/\/ for skills/)).toBeTruthy();

        rerender(<ChatInput onSend={vi.fn()} />);
        expect(screen.queryByPlaceholderText(/\/ for skills/)).toBeNull();
        expect(screen.getByPlaceholderText(/@ for AI employees/)).toBeTruthy();
    });

    // "#" is deliberately unadvertised — files have "+" -> From Drive, drag and
    // paste, so the hint line only teaches the two keys with no other door.
    it('does not advertise "#"', () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        // Assert the exact string: queryByPlaceholderText(/#/) would also pass
        // if the textarea rendered no placeholder at all.
        expect(screen.getByPlaceholderText('Ask anything, / for skills, @ for AI employees...')).toBeTruthy();
    });

    // Regression: the cross-hint was a fourth door into the "/" palette and was
    // not gated, so a widget visitor could reach the tenant's skill library by
    // typing "@", getting no match, and clicking the hint.
    it('does not offer the "/" cross-hint from "@" without an agentId', async () => {
        render(<ChatInput onSend={vi.fn()} />);
        await type('@');

        expect(screen.getByText('mention-palette')).toBeTruthy();
        expect(screen.queryByText('slash-cross-hint')).toBeNull();
    });

    it('opens the skill palette from the "@" cross-hint when there is an agent', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('@');

        await userEvent.click(screen.getByText('slash-cross-hint'));
        expect(screen.getByText('slash-palette')).toBeTruthy();
        expect(screen.queryByText('mention-palette')).toBeNull();
    });

    // SlashPalette has no search input of its own — it filters off the trigger
    // text in the draft. Opened from "+" with nothing typed, the first keystroke
    // used to fail the trigger regex and close the palette immediately.
    it('seeds a "/" so a palette opened from the "+" menu survives typing', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        const box = screen.getByPlaceholderText(/Ask anything/);
        await userEvent.type(box, 'draft ');

        await openAddMenu();
        await userEvent.click(screen.getByText('Use skill'));
        expect((box as HTMLTextAreaElement).value).toBe('draft /');

        await userEvent.type(box, 'blog');
        expect(screen.getByText('slash-palette')).toBeTruthy();
        expect((box as HTMLTextAreaElement).value).toBe('draft /blog');
    });

    it('separates a "+"-opened "/" from a preceding word', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        const box = screen.getByPlaceholderText(/Ask anything/);
        await userEvent.type(box, 'draft');

        await openAddMenu();
        await userEvent.click(screen.getByText('Use skill'));
        // No space before the cursor, so the trigger carries its own separator
        // or the regex (which needs start-or-whitespace) never matches.
        expect((box as HTMLTextAreaElement).value).toBe('draft /');
        expect(screen.getByText('slash-palette')).toBeTruthy();
    });
});

describe('ChatInput skill attach', () => {
    it('attaches the picked skill to the conversation agent', async () => {
        attachSkillToAgent.mockResolvedValue(undefined);
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/blog');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(attachSkillToAgent).toHaveBeenCalledWith('agent-1', SKILL));
        expect(toastSuccess).toHaveBeenCalledWith('Blog Formatter attached to this agent.');
    });

    it('strips the typed "/query" from the draft on pick', async () => {
        attachSkillToAgent.mockResolvedValue(undefined);
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        const box = await type('draft /blog');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('draft '));
    });

    it('surfaces a missing install record rather than failing silently', async () => {
        attachSkillToAgent.mockRejectedValue(new Error('NO_INSTALL_ID'));
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining('no install record')));
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('reports a generic failure when the attach call rejects', async () => {
        attachSkillToAgent.mockRejectedValue(new Error('boom'));
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(toastError).toHaveBeenCalledWith('Failed to attach skill.'));
    });
});
