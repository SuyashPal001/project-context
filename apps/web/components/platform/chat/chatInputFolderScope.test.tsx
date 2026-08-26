/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// ChatInput pulls in uploads, audio recording and palettes on mount. None of
// that matters here — this pins one thing: the folder chip renders wherever the
// composer renders, which is what a grant made from Drive depends on.
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
vi.mock('./SlashPalette', () => ({ SlashPalette: () => null }));
vi.mock('./MentionPalette', () => ({ MentionPalette: () => null }));
vi.mock('./DriveFilePicker', () => ({ DriveFilePicker: () => null }));

import { ChatInput } from './ChatInput';

describe('ChatInput folder scope chip', () => {
    it('shows the grant on a brand-new conversation, where WelcomeView renders', () => {
        // The regression this pins: the chip lived in the page's "has messages"
        // branch only, so the Drive → New session flow — the whole point of the
        // feature — landed on WelcomeView and showed nothing at all.
        render(<ChatInput onSend={vi.fn()} folderPrefix="projects/new/" onRevokeFolder={vi.fn()} />);
        expect(screen.getByText('new')).toBeTruthy();
        expect(screen.getByText(/Agent can read/i)).toBeTruthy();
    });

    it('renders no chip when the conversation has no grant', () => {
        render(<ChatInput onSend={vi.fn()} />);
        expect(screen.queryByText(/Agent can read/i)).toBeNull();
    });
});
