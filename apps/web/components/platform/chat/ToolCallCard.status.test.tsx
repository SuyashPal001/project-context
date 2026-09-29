/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ToolCallCard, AwaitingApprovalContext } from './ToolCallCard';

afterEach(() => cleanup());

const people = ['20 · Middle Eastern woman · bathroom vanity · sage T-shirt', '34 · Indian man · shaded balcony · olive cotton kurta'];

describe('ToolCallCard — live status (tool_status)', () => {
    it('shows the status line instead of "Preparing your image…", with one sub-line per person', () => {
        render(<ToolCallCard toolName="agent-director" query="" status="loading" statusText="Casting 2 people" statusDetails={people} />);
        expect(screen.getByText('Casting 2 people…')).toBeTruthy();
        expect(screen.queryByText('Preparing your image…')).toBeNull();
        for (const line of people) expect(screen.getByText(line)).toBeTruthy();
    });

    it('keeps the people listed while the approval card is open and while generating', () => {
        const { rerender } = render(
            <AwaitingApprovalContext.Provider value={true}>
                <ToolCallCard toolName="agent-director" query="" status="loading" statusText="Casting 2 people" statusDetails={people} />
            </AwaitingApprovalContext.Provider>,
        );
        expect(screen.getByText('Waiting for your approval')).toBeTruthy();
        expect(screen.getByText(people[0])).toBeTruthy();
        rerender(<ToolCallCard toolName="agent-director" query="" status="loading" generationStarted statusText="Casting 2 people" statusDetails={people} />);
        expect(screen.getByText(/Generating visual/)).toBeTruthy();
        expect(screen.getByText(people[1])).toBeTruthy();
    });

    it('drops the sub-lines once the call is done', () => {
        render(<ToolCallCard toolName="agent-director" query="" status="done" result={{}} statusText="Casting 2 people" statusDetails={people} />);
        expect(screen.queryByTestId('tool-status-details')).toBeNull();
    });
});
