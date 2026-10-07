/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ClarificationCard } from './ClarificationCard';
import { uploadToS3 } from './useFileUpload';

vi.mock('./useFileUpload', () => ({ uploadToS3: vi.fn(), MAX_FILES_PER_SELECTION: 5, MAX_ATTACHMENTS_PER_MESSAGE: 20 }));
vi.mock('./AttachmentStrip', () => ({ AttachmentStrip: ({ attachments, onRemove }: any) => attachments.map((file: any) => <button key={file.fileId} onClick={() => onRemove(file.fileId)}>{file.name}</button>) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/platform/files/FileThumbnail', () => ({
    FileThumbnail: ({ fileId, alt, fallbackToLibraryAsset }: any) => (
        <img data-testid="clarification-thumb" data-file-id={fileId} data-fallback={String(!!fallbackToLibraryAsset)} alt={alt} />
    ),
}));
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

describe('multiSelect', () => {
    const multiRequest = { id: 'q2', status: 'pending' as const, questions: [
        { prompt: 'Pick 3 logos', allowSkip: true, multiSelect: { min: 3, max: 3 }, options: [
            { label: 'Invercorp' }, { label: 'Burger King' }, { label: 'Disney' }, { label: 'Liquid Life' },
        ] },
    ] };

    it('keeps Submit disabled until min is reached, then submits selectedIndices', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={multiRequest} onAnswer={onAnswer} />);
        expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByText('1. Invercorp'));
        expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByText('3. Disney'));
        expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(true);
        fireEvent.click(screen.getByText('4. Liquid Life'));
        expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByText('Submit'));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndices: [0, 2, 3] }, true));
    });

    it('toggles a selection off on a second click', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={multiRequest} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByText('1. Invercorp'));
        fireEvent.click(screen.getByText('1. Invercorp'));
        fireEvent.click(screen.getByText('2. Burger King'));
        fireEvent.click(screen.getByText('3. Disney'));
        fireEvent.click(screen.getByText('4. Liquid Life'));
        expect((screen.getByText('Submit') as HTMLButtonElement).disabled).toBe(false);
        fireEvent.click(screen.getByText('Submit'));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndices: [1, 2, 3] }, true));
    });

    it('blocks selecting a 4th option once at max', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={multiRequest} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByText('1. Invercorp'));
        fireEvent.click(screen.getByText('2. Burger King'));
        fireEvent.click(screen.getByText('3. Disney'));
        fireEvent.click(screen.getByText('4. Liquid Life')); // 4th click while already at max — should no-op
        fireEvent.click(screen.getByText('Submit'));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndices: [0, 1, 2] }, true));
    });
});

describe('image-backed options (avatar/casting picks)', () => {
    const imageRequest = { id: 'q3', status: 'pending' as const, questions: [
        { prompt: 'Which one should become your avatar?', allowSkip: true, options: [
            { label: 'Option 1', imageFileId: '11111111-1111-1111-1111-111111111111' },
            { label: 'Option 2', imageFileId: '22222222-2222-2222-2222-222222222222' },
            { label: 'None of these — change something' },
        ] },
    ] };

    it('renders image tiles for options with imageFileId and plain text rows for the rest', () => {
        render(<ClarificationCard request={imageRequest} onAnswer={vi.fn()} />);
        const thumbs = screen.getAllByTestId('clarification-thumb');
        expect(thumbs).toHaveLength(2);
        expect(thumbs[0].getAttribute('data-file-id')).toBe('11111111-1111-1111-1111-111111111111');
        expect(thumbs[0].getAttribute('data-fallback')).toBe('true');
        expect(screen.getByText('1. Option 1')).toBeTruthy();
        expect(screen.getByText('2. Option 2')).toBeTruthy();
        // The no-image option stays a plain text row, not a tile.
        expect(screen.getByText('3. None of these — change something')).toBeTruthy();
    });

    it('clicking a tile selects it and submits the same answer shape as a text option', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={imageRequest} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByText('2. Option 2'));
        fireEvent.click(screen.getByText('Submit'));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndex: 1 }, true));
    });

    it('clicking the text-only "none of these" option still works normally', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={imageRequest} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByText('3. None of these — change something'));
        fireEvent.click(screen.getByText('Submit'));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith({ questionIndex: 0, selectedIndex: 2 }, true));
    });
});

describe('single choice', () => {
    const single = { id: 'q3', status: 'pending' as const, questions: [
        { prompt: 'Approve the stills?', options: [{ label: 'Approve' }, { label: 'Regenerate' }], allowSkip: true },
    ] };
    it('clears a chosen option on a second click, so a typed answer can go alone', async () => {
        const onAnswer = vi.fn().mockResolvedValue(true);
        render(<ClarificationCard request={single} onAnswer={onAnswer} />);
        fireEvent.click(screen.getByText('2. Regenerate'));
        fireEvent.click(screen.getByText('2. Regenerate'));
        fireEvent.change(screen.getByPlaceholderText('Type an answer or attach files'), { target: { value: 'wait' } });
        fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
        await waitFor(() => expect(onAnswer).toHaveBeenCalledWith(expect.not.objectContaining({ selectedIndex: expect.anything() }), true));
        expect(onAnswer.mock.calls[0][0]).toMatchObject({ freeText: 'wait' });
    });
});

it('shows only the question once answered when the answer is the next message', () => {
    const answered = { id: 'q2', status: 'answered' as const, questions: [{ prompt: 'Does Scene 1 look right?', options: [{ label: 'Looks good — continue' }], allowSkip: true }], answers: { 0: { selectedIndex: 0 } } };
    render(<ClarificationCard request={answered} onAnswer={vi.fn()} promptOnly />);
    expect(screen.getByText('Does Scene 1 look right?')).toBeTruthy();
    expect(screen.queryByText('Looks good — continue')).toBeNull();
    expect(screen.queryByText('1 answer')).toBeNull();
});
