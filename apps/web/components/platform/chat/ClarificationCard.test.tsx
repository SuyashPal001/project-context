/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ClarificationCard } from './ClarificationCard';
import { uploadToS3 } from './useFileUpload';

vi.mock('./useFileUpload', () => ({ uploadToS3: vi.fn(), MAX_FILES_PER_SELECTION: 5, MAX_ATTACHMENTS_PER_MESSAGE: 20 }));
vi.mock('./AttachmentStrip', () => ({ AttachmentStrip: ({ attachments, onRemove }: any) => attachments.map((file: any) => <button key={file.fileId} onClick={() => onRemove(file.fileId)}>{file.name}</button>) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
const request = { id: 'q1', status: 'pending' as const, questions: [
    { prompt: 'Upload your product image', options: [], allowSkip: true },
    { prompt: 'Choose a style', options: [{ label: 'Simple' }], allowSkip: true },
] };

it('waits for uploads, submits files without text, and keeps attachments on their question', async () => {
    let finish!: (id: string) => void;
    vi.mocked(uploadToS3).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const onAnswer = vi.fn().mockResolvedValue(true);
    render(<ClarificationCard request={request} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText('Attach files to answer'), { target: { files: [new File(['image'], 'product.png', { type: 'image/png' })] } });
    expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(true);
    finish('file-1');
    await screen.findByText('product.png');
    fireEvent.click(screen.getByText('Continue'));
    await screen.findByText('Choose a style');
    expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, files: [{ fileId: 'file-1', name: 'product.png', type: 'image/png' }] }, false);
    expect(screen.queryByText('product.png')).toBeNull();
    fireEvent.click(screen.getByText('1. Simple'));
    fireEvent.click(screen.getByText('Submit'));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith({ questionIndex: 1, selectedIndex: 0 }, true));
});

it('does not count a failed answer as complete and preserves its files for retry', async () => {
    vi.mocked(uploadToS3).mockResolvedValue('file-2');
    const onAnswer = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<ClarificationCard request={request} onAnswer={onAnswer} />);
    fireEvent.change(screen.getByLabelText('Attach files to answer'), { target: { files: [new File(['image'], 'retry.png', { type: 'image/png' })] } });
    await screen.findByText('retry.png');
    fireEvent.click(screen.getByText('Continue'));
    await waitFor(() => expect((screen.getByText('Continue') as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('retry.png')).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Next question'));
    fireEvent.click(screen.getByText('1. Simple'));
    fireEvent.click(screen.getByText('Submit'));
    await waitFor(() => expect(onAnswer).toHaveBeenLastCalledWith({ questionIndex: 1, selectedIndex: 0 }, false));
});
