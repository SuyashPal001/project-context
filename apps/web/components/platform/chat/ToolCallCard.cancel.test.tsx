/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ToolCallCard, AwaitingApprovalContext } from './ToolCallCard';

afterEach(() => cleanup());

describe('ToolCallCard — cancelled / awaiting approval', () => {
    it('shows "Cancelled", not "Visual created", for a cancelled generation', () => {
        render(<ToolCallCard toolName="agent-director" query="a car" status="done" result={{ cancelled: true }} />);
        expect(screen.getByText('Cancelled')).toBeTruthy();
        expect(screen.queryByText(/Visual created/)).toBeNull();
    });

    it('shows "Waiting for your approval" with no media skeleton while the approval card is open', () => {
        const { container } = render(
            <AwaitingApprovalContext.Provider value={true}>
                <ToolCallCard toolName="agent-director" query="a car" status="loading" />
            </AwaitingApprovalContext.Provider>,
        );
        expect(screen.getByText('Waiting for your approval')).toBeTruthy();
        expect(screen.queryByText(/Generating visual/)).toBeNull();
        expect(container.querySelector('.aspect-video')).toBeNull();
    });

    it('shows "Preparing your image…" with no skeleton while the delegate has not started generating', () => {
        const { container } = render(<ToolCallCard toolName="agent-director" query="" status="loading" />);
        expect(screen.getByText('Preparing your image…')).toBeTruthy();
        expect(screen.queryByText(/Generating visual/)).toBeNull();
        expect(container.querySelector('.aspect-video')).toBeNull();
    });

    it('shows the generating skeleton once generation has started', () => {
        const { container } = render(<ToolCallCard toolName="agent-director" query="" status="loading" generationStarted />);
        expect(screen.getByText(/Generating visual/)).toBeTruthy();
        expect(container.querySelector('.aspect-video')).not.toBeNull();
    });

    it('says audio, not image, when the director is handed a narration (query is empty for delegates)', () => {
        render(<ToolCallCard toolName="agent-director" query="" prompt={'flow: talking head\n\nGenerate narration for a 15-second UGC ad.'} status="loading" />);
        expect(screen.getByText('Preparing your audio…')).toBeTruthy();
        cleanup();
        render(<ToolCallCard toolName="agent-director" query="" prompt="Generate narration for the ad." status="done" result={{}} />);
        expect(screen.getByText(/Audio created/)).toBeTruthy();
    });
});
