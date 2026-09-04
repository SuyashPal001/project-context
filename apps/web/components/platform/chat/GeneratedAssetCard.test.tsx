/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GeneratedAssetCard } from './GeneratedAssetCard';
import type { MessageAttachment } from './types';

afterEach(() => cleanup());

const baseFile: MessageAttachment = {
    id: 'att-1', fileId: 'f1', name: 'sunset.png', type: 'image/png', size: 12345,
};

describe('GeneratedAssetCard', () => {
    it('renders the plain attachment card with no credit pill when generation is absent', () => {
        render(<GeneratedAssetCard file={baseFile} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);
        expect(screen.queryByTestId('generation-credit-pill')).toBeNull();
    });

    it('shows a credit pill when generation metadata is present', () => {
        const file: MessageAttachment = {
            ...baseFile,
            generation: { creditsUsedMicro: '310000', model: 'gpt-image-2' },
        };
        render(<GeneratedAssetCard file={file} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);
        const pill = screen.getByTestId('generation-credit-pill');
        expect(pill.textContent).toContain('0.31');
    });

    it('expands to show model and credits used, and omits fields that are not known', async () => {
        const file: MessageAttachment = {
            ...baseFile,
            generation: { creditsUsedMicro: '310000', model: 'gpt-image-2' },
        };
        render(<GeneratedAssetCard file={file} url="https://example.com/img.png" createdAt="2026-09-04T12:00:00.000Z" />);

        await userEvent.click(screen.getByTestId('generation-credit-pill'));

        const details = await screen.findByTestId('generation-details');
        expect(details.textContent).toContain('gpt-image-2');
        expect(details.textContent).toContain('0.31');
        expect(details.textContent).not.toContain('Aspect ratio');
        expect(details.textContent).not.toContain('Resolution');
        expect(details.textContent).not.toContain('Seed');
    });
});
