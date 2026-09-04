/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Same rationale as chatInputFolderScope.test.tsx: ChatInput drags in uploads,
// audio recording and palettes on mount, none of which matter for pinning
// whether the allow-mode dropdown renders and reports its current value.
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
vi.mock('./HashFilePalette', () => ({ HashFilePalette: () => null }));

import { ChatInput } from './ChatInput';

describe('ChatInput allow-mode dropdown', () => {
    it('renders no dropdown when onAllowModeChange is not provided', () => {
        render(<ChatInput onSend={vi.fn()} />);
        expect(screen.queryByText('Ask')).toBeNull();
        expect(screen.queryByText('Auto')).toBeNull();
    });

    it('shows "Ask" as the trigger label by default', () => {
        render(<ChatInput onSend={vi.fn()} allowMode="ask" onAllowModeChange={vi.fn()} />);
        expect(screen.getByText('Ask')).toBeTruthy();
    });

    it('shows "Auto" as the trigger label when set to auto', () => {
        render(<ChatInput onSend={vi.fn()} allowMode="auto" onAllowModeChange={vi.fn()} />);
        expect(screen.getByText('Auto')).toBeTruthy();
    });
});
