/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { BrandFillRow } from './BrandFillRow';
import { EMPTY_BRAND, type BrandRecord } from './brandApi';

describe('BrandFillRow', () => {
    it('renders the input, Fill in button and the Ask Olmo link with its href unchanged', () => {
        render(<BrandFillRow brand={EMPTY_BRAND} chatHref="/t/dashboard/chat?prefill=Set%20up%20my%20brand" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect(screen.getByLabelText('Website or Instagram handle')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Fill in' })).toBeTruthy();
        const link = screen.getByRole('link', { name: 'Ask Olmo →' }) as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('/t/dashboard/chat?prefill=Set%20up%20my%20brand');
    });

    it('Fill in calls onSubmit(value)', () => {
        const onSubmit = vi.fn();
        render(<BrandFillRow brand={EMPTY_BRAND} chatHref="/t" onSubmit={onSubmit} busy={false} failed={false} />);
        fireEvent.change(screen.getByLabelText('Website or Instagram handle'), { target: { value: '@mamaearth.in' } });
        fireEvent.click(screen.getByRole('button', { name: 'Fill in' }));
        expect(onSubmit).toHaveBeenCalledWith('@mamaearth.in');
    });

    it('disables Fill in when the input is empty', () => {
        render(<BrandFillRow brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect((screen.getByRole('button', { name: 'Fill in' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('disables Fill in while an import is busy', () => {
        render(<BrandFillRow brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn()} busy failed={false} />);
        fireEvent.change(screen.getByLabelText('Website or Instagram handle'), { target: { value: '@mamaearth.in' } });
        expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    });

    it('shows the failure line when the import failed', () => {
        render(<BrandFillRow brand={EMPTY_BRAND} chatHref="/t" onSubmit={vi.fn()} busy={false} failed />);
        expect(screen.getByText("Couldn't read that — fill it in below, or ask Olmo.")).toBeTruthy();
    });

    it('is hidden once the brand has a website source', () => {
        const brand: BrandRecord = { ...EMPTY_BRAND, sourceType: 'website', sourceValue: 'https://mamaearth.in/' };
        const { container } = render(<BrandFillRow brand={brand} chatHref="/t" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect(container.firstChild).toBeNull();
    });

    it('is hidden once the brand has an instagram source', () => {
        const brand: BrandRecord = { ...EMPTY_BRAND, sourceType: 'instagram', sourceValue: '@mamaearth' };
        const { container } = render(<BrandFillRow brand={brand} chatHref="/t" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect(container.firstChild).toBeNull();
    });

    it('still shows when the source is chat', () => {
        const brand: BrandRecord = { ...EMPTY_BRAND, sourceType: 'chat' };
        render(<BrandFillRow brand={brand} chatHref="/t" onSubmit={vi.fn()} busy={false} failed={false} />);
        expect(screen.getByLabelText('Website or Instagram handle')).toBeTruthy();
    });
});
