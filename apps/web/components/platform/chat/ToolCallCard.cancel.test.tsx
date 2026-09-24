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

    it('still shows the skeleton when nothing is awaiting approval', () => {
        const { container } = render(<ToolCallCard toolName="agent-director" query="" status="loading" />);
        expect(screen.getByText(/Generating visual/)).toBeTruthy();
        expect(container.querySelector('.aspect-video')).not.toBeNull();
    });
});
