/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { ToolCallCard, estimatedProgress } from './ToolCallCard';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('estimatedProgress', () => {
  it('starts at 0, rises, and never passes 95', () => {
    expect(estimatedProgress(0, 22_000)).toBe(0);
    const mid = estimatedProgress(11_000, 22_000);
    const atExpected = estimatedProgress(22_000, 22_000);
    expect(mid).toBeGreaterThan(0);
    expect(atExpected).toBeGreaterThan(mid);
    expect(atExpected).toBeGreaterThanOrEqual(80);
    expect(estimatedProgress(10 * 60_000, 22_000)).toBe(95);
  });
});

describe('media skeleton progress', () => {
  it('shows a percentage that climbs while the image generates', () => {
    vi.useFakeTimers();
    render(<ToolCallCard toolName="generate_image" query="" status="loading" />);
    expect(screen.getByTestId('media-progress-pct').textContent).toBe('0%');
    act(() => { vi.advanceTimersByTime(11_000); });
    const pct = Number(screen.getByTestId('media-progress-pct').textContent?.replace('%', ''));
    expect(pct).toBeGreaterThan(40);
    expect(pct).toBeLessThan(95);
  });
});
