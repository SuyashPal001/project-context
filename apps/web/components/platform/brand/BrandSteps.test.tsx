/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BrandSteps } from './BrandSteps';
import { EMPTY_BRAND } from './brandApi';

describe('BrandSteps', () => {
    it('renders step 1 of 3 with Basics fields', () => {
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
        expect(screen.getByLabelText('Brand name')).toBeTruthy();
        expect(screen.queryByLabelText('Tone words')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    });

    it('a field blur on step 1 calls onSave with only that field', () => {
        const onSave = vi.fn();
        render(<BrandSteps brand={EMPTY_BRAND} onSave={onSave} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        const name = screen.getByLabelText('Brand name');
        fireEvent.change(name, { target: { value: 'Mamaearth' } });
        fireEvent.blur(name);
        expect(onSave).toHaveBeenCalledWith({ name: 'Mamaearth' });
    });

    it('Next advances to step 2 (Voice)', () => {
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
        expect(screen.getByText('Tone words')).toBeTruthy();
    });

    it('Skip also advances', () => {
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
    });

    it('Back goes back a step', () => {
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText(/Step 2 of 3/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Back' }));
        expect(screen.getByText(/Step 1 of 3/)).toBeTruthy();
    });

    it('reaches step 3 (Look) with Back present and button labelled Done', () => {
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(screen.getByText(/Step 3 of 3/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    });

    it('Done on step 3 calls the finish callback', () => {
        const onFinish = vi.fn();
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={onFinish} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(onFinish).toHaveBeenCalled();
    });

    it('Skip on step 3 also calls the finish callback', () => {
        const onFinish = vi.fn();
        render(<BrandSteps brand={EMPTY_BRAND} onSave={vi.fn()} onUploadImage={vi.fn()} onFinish={onFinish} />);
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
        expect(onFinish).toHaveBeenCalled();
    });
});
