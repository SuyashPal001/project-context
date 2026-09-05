/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render as rtlRender, screen, cleanup, waitFor, type RenderResult } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { ApproveCost } from './ApproveCost';

const apiGetMock = vi.fn();

vi.mock('@/lib/api', () => ({
    api: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

vi.mock('@/app/[tenant]/tenant-provider', () => ({
    useTenant: () => ({ tenantSlug: 'acme' }),
}));

afterEach(() => {
    cleanup();
    apiGetMock.mockReset();
});

function render(ui: ReactElement): RenderResult {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('ApproveCost', () => {
    it('shows a loading state before the estimate resolves', () => {
        apiGetMock.mockReturnValue(new Promise(() => {})); // never resolves
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={vi.fn()} />);
        expect(screen.getByTestId('approve-cost-loading')).not.toBeNull();
    });

    it('divides costMicro by 1,000,000 for display and does not show the balance', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" subject="task.create" onApprove={vi.fn()} onCancel={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost');
        expect(el.textContent).toContain('~2 credits');
        expect(el.textContent).not.toContain('Balance');
    });

    it('renders "Unlimited" with no cost figure when the tenant is unlimited, and Approve stays enabled', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: true,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost-unlimited');
        expect(el.textContent).toContain('Unlimited plan');
        expect(el.textContent).not.toContain('~');
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(false);
    });

    it('disables the numbered Approve option and shows a billing link when sufficient is false', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '500000',
            sufficient: false,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={vi.fn()} />);

        const el = await screen.findByTestId('approve-cost');
        const approveOption = screen.getByRole('button', { name: /1\. Approve/ }) as HTMLButtonElement;
        expect(approveOption.disabled).toBe(true);
        // Insufficient hides the footer's own Approve shortcut too — only the
        // disabled numbered option and Skip remain.
        expect(el.querySelector('kbd')?.textContent).toBe('ESC');
        const link = screen.getByRole('link', { name: /add more/i }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/acme/dashboard/billing');
    });

    it('calls onApprove when the numbered Approve option is clicked', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onApprove = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={onApprove} onCancel={vi.fn()} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: /1\. Approve/ }));

        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('calls onApprove when the footer Approve shortcut is clicked', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onApprove = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={onApprove} onCancel={vi.fn()} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: 'Approve' }));

        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it('calls onCancel with no reason when Skip is clicked', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onCancel = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={onCancel} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: /Skip/ }));

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledWith();
    });

    it('calls onCancel with no reason when the numbered "Hold off" option is clicked', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onCancel = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={onCancel} />);

        await screen.findByTestId('approve-cost');
        await userEvent.click(screen.getByRole('button', { name: /2\. Hold off/ }));

        expect(onCancel).toHaveBeenCalledWith();
    });

    it('calls onCancel with the typed reason when the free-text field is submitted', async () => {
        apiGetMock.mockResolvedValue({
            costMicro: '2000000',
            balanceMicro: '10000000',
            sufficient: true,
            rateId: 'rate-1',
            rateVersion: 1,
            unlimited: false,
        });
        const onCancel = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={onCancel} />);

        await screen.findByTestId('approve-cost');
        await userEvent.type(screen.getByPlaceholderText(/tell me what to change/i), 'Make it slower');
        await userEvent.click(screen.getByRole('button', { name: 'Send' }));

        expect(onCancel).toHaveBeenCalledWith('Make it slower');
    });

    it('still offers an enabled Approve when the estimate call fails — a preview failure must never block approval', async () => {
        apiGetMock.mockRejectedValue(new Error('network error'));
        const onApprove = vi.fn();
        render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={onApprove} onCancel={vi.fn()} />);

        await waitFor(() => expect(screen.getByTestId('approve-cost-error')).not.toBeNull());
        const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
        expect(approveBtn.disabled).toBe(false);

        await userEvent.click(approveBtn);
        expect(onApprove).toHaveBeenCalledTimes(1);
    });

    // 'skill_creation' is not a CreditResourceType. Casting it to one made the
    // estimate query fire against a resource that has no rate, so the card fell
    // into its isError branch and told the user "Couldn't estimate cost" for a
    // write that costs nothing. resourceType={null} is the unpriced branch.
    describe('unpriced confirmations (resourceType={null})', () => {
        it('never fetches an estimate and never shows the estimate-failed copy', async () => {
            render(<ApproveCost label='Create skill "Bid Writer"' resourceType={null} onApprove={vi.fn()} onCancel={vi.fn()} />);

            const el = await screen.findByTestId('approve-cost-unpriced');
            expect(apiGetMock).not.toHaveBeenCalled();
            expect(el.textContent).not.toContain("Couldn't estimate cost");
            expect(el.textContent).toContain("doesn't use credits");
        });

        it('offers an enabled Approve', async () => {
            const onApprove = vi.fn();
            render(<ApproveCost label='Create skill "Bid Writer"' resourceType={null} onApprove={onApprove} onCancel={vi.fn()} />);

            await screen.findByTestId('approve-cost-unpriced');
            const approveBtn = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
            expect(approveBtn.disabled).toBe(false);
            await userEvent.click(approveBtn);
            expect(onApprove).toHaveBeenCalledTimes(1);
        });
    });

    // The spec rests the credential/PII defence on this card being "the real
    // control". A card that shows only a name is asking the user to approve text
    // they cannot see.
    describe('preview', () => {
        it('renders the body being approved, verbatim', async () => {
            render(
                <ApproveCost
                    label='Create skill "Bid Writer"'
                    resourceType={null}
                    preview={'---\nname: bid-writer\n---\n\nOpen with the client name.'}
                    onApprove={vi.fn()}
                    onCancel={vi.fn()}
                />,
            );

            const preview = await screen.findByTestId('approve-cost-preview');
            expect(preview.textContent).toContain('name: bid-writer');
            expect(preview.textContent).toContain('Open with the client name.');
        });

        it('renders no preview block when the caller passes none', async () => {
            apiGetMock.mockResolvedValue({
                costMicro: '2000000', sufficient: true, rateId: 'rate-1', rateVersion: 1, unlimited: false,
            });
            render(<ApproveCost label="Generate song" resourceType="tool_call" onApprove={vi.fn()} onCancel={vi.fn()} />);

            await screen.findByTestId('approve-cost');
            expect(screen.queryByTestId('approve-cost-preview')).toBeNull();
        });
    });
});
