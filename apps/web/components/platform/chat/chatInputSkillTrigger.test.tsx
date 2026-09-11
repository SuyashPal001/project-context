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
const toastInfo = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: (m: string) => toastSuccess(m), info: (m: string) => toastInfo(m) } }));

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
    it('never attaches the picked skill to the agent — it only becomes a draft chip', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        await type('/blog');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(screen.getByText('Blog Formatter')).toBeTruthy());
        expect(attachSkillToAgent).not.toHaveBeenCalled();
    });

    it('strips the typed "/query" from the draft on pick', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" />);
        const box = await type('draft /blog');

        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe('draft '));
    });
});

describe('ChatInput conversation skills', () => {
    const INVOKED = { skillId: 'skill-9', installId: 'install-9', name: 'UGC Ad Production' };

    it('shows a chip for each skill turned on in this conversation, and X removes it from the conversation', async () => {
        const onRemove = vi.fn();
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" invokedSkills={[INVOKED]} onRemoveInvokedSkill={onRemove} />);

        expect(screen.getByText('UGC Ad Production')).toBeTruthy();
        await userEvent.click(screen.getByTitle('Dismiss'));
        expect(onRemove).toHaveBeenCalledWith('skill-9');
    });

    it('keeps the existing conversation chip and adds a new one for a different pick', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" invokedSkills={[{ skillId: 'skill-2', installId: 'install-2', name: 'Other Skill' }]} />);
        await type('/blog');
        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(screen.getByText('Blog Formatter')).toBeTruthy());
        expect(screen.getByText('Other Skill')).toBeTruthy();
    });

    it('shows one chip when a draft pick is already on in the conversation', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" invokedSkills={[{ skillId: 'skill-1', installId: 'install-1', name: 'Blog Formatter' }]} />);
        await type('/blog');
        await userEvent.click(screen.getByText('slash-palette'));

        await waitFor(() => expect(screen.getAllByText('Blog Formatter')).toHaveLength(1));
    });

    it('sends the draft picks with the message as skillsUsed', async () => {
        const onSend = vi.fn();
        render(<ChatInput onSend={onSend} agentId="agent-1" />);
        const box = await type('/blog');
        await userEvent.click(screen.getByText('slash-palette'));
        await userEvent.type(box, 'write me an intro{enter}');

        await waitFor(() => expect(onSend).toHaveBeenCalled());
        expect(onSend.mock.calls[0][2]).toEqual([{ id: 'skill-1', name: 'Blog Formatter' }]);
    });
});

describe('ChatInput in a Test-in-chat conversation', () => {
    it('does not open the skill palette on "/", and says why', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        await type('/');

        expect(screen.queryByText('slash-palette')).toBeNull();
        expect(toastInfo).toHaveBeenCalledWith('Test chats run one skill. Start a normal chat to combine skills.');
    });

    it('shows the hint once per draft, not once per keystroke', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        await type('/abc');
        expect(toastInfo).toHaveBeenCalledTimes(1);
    });

    it('does not advertise "/" or offer "Use skill"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        expect(screen.queryByPlaceholderText(/\/ for skills/)).toBeNull();
        await openAddMenu();
        expect(screen.queryByText('Use skill')).toBeNull();
    });

    it('hides the "/" cross-hint from "@"', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        await type('@');

        expect(screen.getByText('mention-palette')).toBeTruthy();
        expect(screen.queryByText('slash-cross-hint')).toBeNull();
    });

    it('shows the hint again on the next draft after a normal send', async () => {
        render(<ChatInput onSend={vi.fn()} agentId="agent-1" isTestChat />);
        const box = await type('/');
        expect(toastInfo).toHaveBeenCalledTimes(1);

        await userEvent.clear(box);
        await userEvent.type(box, 'hello{enter}');

        await type('/');
        expect(toastInfo).toHaveBeenCalledTimes(2);
    });
});
