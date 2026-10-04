/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

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

describe('ChatInput queued messages', () => {
    const type = (text: string) => fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
    const enter = () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    it('queues a message typed while the agent works instead of stopping it, then sends it when the turn ends', () => {
        const onSend = vi.fn();
        const onStop = vi.fn();
        const { rerender } = render(<ChatInput onSend={onSend} onStop={onStop} isStreaming queueKey="c1" />);
        type('make her smile more');
        enter();
        expect(onStop).not.toHaveBeenCalled();
        expect(onSend).not.toHaveBeenCalled();
        expect(screen.getByTestId('queued-message').textContent).toContain('make her smile more');
        rerender(<ChatInput onSend={onSend} onStop={onStop} isStreaming={false} queueKey="c1" />);
        expect(onSend).toHaveBeenCalledWith('make her smile more', undefined, undefined);
        expect(screen.queryByTestId('queued-message')).toBeNull();
    });

    it('joins several queued messages into one', () => {
        const onSend = vi.fn();
        const { rerender } = render(<ChatInput onSend={onSend} isStreaming queueKey="c1" />);
        type('first'); enter();
        type('second'); enter();
        rerender(<ChatInput onSend={onSend} isStreaming={false} queueKey="c1" />);
        expect(onSend).toHaveBeenCalledTimes(1);
        expect(onSend).toHaveBeenCalledWith('first\n\nsecond', undefined, undefined);
    });

    it('drops the queue when the conversation changes, and can be removed by hand', () => {
        const onSend = vi.fn();
        const { rerender } = render(<ChatInput onSend={onSend} isStreaming queueKey="c1" />);
        type('for chat one'); enter();
        rerender(<ChatInput onSend={onSend} isStreaming queueKey="c2" />);
        expect(screen.queryByTestId('queued-message')).toBeNull();
        type('again'); enter();
        fireEvent.click(screen.getByLabelText('Remove queued message'));
        rerender(<ChatInput onSend={onSend} isStreaming={false} queueKey="c2" />);
        expect(onSend).not.toHaveBeenCalled();
    });

    it('still stops only from the Stop button', () => {
        const onStop = vi.fn();
        render(<ChatInput onSend={vi.fn()} onStop={onStop} isStreaming />);
        fireEvent.click(screen.getByLabelText('Stop'));
        expect(onStop).toHaveBeenCalledTimes(1);
    });
});
