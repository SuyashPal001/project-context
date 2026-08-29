// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StorageMeter, shouldShowMeter } from './StorageMeter';

describe('shouldShowMeter', () => {
  it('stays hidden under 80%, which is the whole point of the feature', () => {
    // Storage limits are unadvertised. A meter at ordinary usage would be the
    // product telling every user about a ceiling they will never reach.
    expect(shouldShowMeter({ percent: 79, unlimited: false })).toBe(false);
  });

  it('appears at exactly 80%', () => {
    expect(shouldShowMeter({ percent: 80, unlimited: false })).toBe(true);
  });

  it('never appears for unlimited plans', () => {
    expect(shouldShowMeter({ percent: 100, unlimited: true })).toBe(false);
  });
});

describe('StorageMeter', () => {
  it('names the concrete numbers, since nothing else in the product does', () => {
    render(<StorageMeter percent={85} usedBytes={17 * 1024 ** 3} limitBytes={20 * 1024 ** 3} />);
    expect(screen.getByText(/17 GB of 20 GB/i)).toBeDefined();
  });

  it('shows a sub-GB figure without rounding it away to zero', () => {
    // A tenant at 80% of a small limit would otherwise be told "0 GB of 1 GB",
    // which reads as a bug rather than a warning.
    render(<StorageMeter percent={85} usedBytes={880 * 1024 ** 2} limitBytes={1024 ** 3} />);
    expect(screen.getByText(/0\.86 GB of 1 GB/i)).toBeDefined();
  });
});
