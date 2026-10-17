/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrandFillButton } from './BrandFillButton';
import { EMPTY_BRAND, type BrandRecord } from './brandApi';
import { ApiError } from '@/lib/api';

const open = () => fireEvent.click(screen.getByRole('button', { name: /Fill in with AI/ }));

describe('BrandFillButton', () => {
    it('is one button until opened', () => {
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t/chat" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy={false} failed={false} />);
        expect(screen.getByRole('button', { name: /Fill in with AI/ })).toBeTruthy();
        expect(screen.queryByLabelText('Website or Instagram handle')).toBeNull();
    });

    it('opens a card with the link box, Fill in and the chat link (href unchanged)', async () => {
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy={false} failed={false} />);
        open();
        expect(await screen.findByLabelText('Website or Instagram handle')).toBeTruthy();
        const link = screen.getByRole('link', { name: 'Tell Olmo in chat →' }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/t/dashboard/chat?prefill=Set%20up%20my%20brand');
    });

    it('Fill in submits the value and closes once the read has started', async () => {
        const onSubmit = vi.fn(async () => ({ ...EMPTY_BRAND, importStatus: 'importing' as const }));
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={onSubmit} busy={false} failed={false} />);
        open();
        fireEvent.change(await screen.findByLabelText('Website or Instagram handle'), { target: { value: '@mamaearth.in' } });
        fireEvent.click(screen.getByRole('button', { name: 'Fill in' }));
        expect(onSubmit).toHaveBeenCalledWith('@mamaearth.in');
        await waitFor(() => expect(screen.queryByLabelText('Website or Instagram handle')).toBeNull());
    });

    it('keeps the card open and explains when the site cannot be read', async () => {
        const onSubmit = vi.fn(async () => ({ ...EMPTY_BRAND, importStatus: 'failed' as const }));
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={onSubmit} busy={false} failed={false} />);
        open();
        fireEvent.change(await screen.findByLabelText('Website or Instagram handle'), { target: { value: 'blocked.example' } });
        fireEvent.click(screen.getByRole('button', { name: 'Fill in' }));
        expect(await screen.findByText("Couldn't read that. Fill it in yourself, or tell Olmo in chat.")).toBeTruthy();
        expect(screen.getByLabelText('Website or Instagram handle')).toBeTruthy();
    });

    it('shows the format hint inside the card for input that is not a site or handle', async () => {
        const onSubmit = vi.fn(async () => { throw new ApiError(400, { message: 'Paste a website link or an Instagram handle' }) })
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={onSubmit} busy={false} failed={false} />);
        open();
        fireEvent.change(await screen.findByLabelText('Website or Instagram handle'), { target: { value: 'hello world' } });
        fireEvent.click(screen.getByRole('button', { name: 'Fill in' }));
        expect(await screen.findByText('Paste a website link or an Instagram handle')).toBeTruthy();
    });

    it('Fill in is disabled while the box is empty', async () => {
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy={false} failed={false} />);
        open();
        await screen.findByLabelText('Website or Instagram handle');
        expect((screen.getByRole('button', { name: 'Fill in' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows "Filling in…" and is disabled while an import runs', () => {
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy failed={false} />);
        const btn = screen.getByRole('button', { name: /Filling in/ }) as HTMLButtonElement;
        expect(btn.disabled).toBe(true);
    });

    it('says plainly when the site could not be read', async () => {
        render(<BrandFillButton brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy={false} failed />);
        open();
        expect(await screen.findByText("Couldn't read that. Fill it in yourself, or tell Olmo in chat.")).toBeTruthy();
    });

    it('starts the box with the saved source so a refill is one click', async () => {
        const brand: BrandRecord = { ...EMPTY_BRAND, sourceType: 'website', sourceValue: 'https://fitnearn.com/' };
        render(<BrandFillButton brand={brand} chatHref="/t" onSubmit={vi.fn(async () => EMPTY_BRAND)} busy={false} failed={false} />);
        open();
        expect(((await screen.findByLabelText('Website or Instagram handle')) as HTMLInputElement).value).toBe('fitnearn.com');
    });
});
