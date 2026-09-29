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

describe('skeleton shape', () => {
  it('is vertical for a 9:16 generation and 16:9 when unknown', () => {
    const { rerender } = render(<ToolCallCard toolName="generate_video" query="" status="loading" aspectRatio="9:16" />);
    let sk = screen.getByTestId('media-progress-skeleton');
    expect(sk.className).toContain('max-w-[180px]');
    expect(sk.style.aspectRatio).toBe(String(9 / 16));
    rerender(<ToolCallCard toolName="generate_video" query="" status="loading" />);
    sk = screen.getByTestId('media-progress-skeleton');
    expect(sk.className).toContain('aspect-video');
  });
});

describe('batch generation tiles', () => {
  it('renders N skeleton tiles side by side when the batch total is known via mediaCount', () => {
    render(<ToolCallCard toolName="generate_images" query="" status="loading" mediaCount={4} />);
    const tiles = screen.getAllByTestId('media-progress-skeleton');
    expect(tiles).toHaveLength(4);
    const row = screen.getByTestId('media-progress-tiles');
    expect(row.className).toContain('flex-wrap');
  });

  it('renders N tiles from batchProgress.total and marks the done ones complete', () => {
    render(<ToolCallCard toolName="generate_images" query="" status="loading" batchProgress={{ done: 2, total: 4 }} />);
    const pcts = screen.getAllByTestId('media-progress-pct');
    expect(pcts).toHaveLength(4);
    expect(pcts.filter(el => el.textContent === '100%')).toHaveLength(2);
  });

  it('falls back to a single tile when the batch total is unknown', () => {
    render(<ToolCallCard toolName="generate_images" query="" status="loading" />);
    expect(screen.getAllByTestId('media-progress-skeleton')).toHaveLength(1);
    expect(screen.queryByTestId('media-progress-tiles')).toBeNull();
  });

  it('ignores a total of 1 and renders the plain single skeleton', () => {
    render(<ToolCallCard toolName="generate_images" query="" status="loading" mediaCount={1} />);
    expect(screen.getAllByTestId('media-progress-skeleton')).toHaveLength(1);
    expect(screen.queryByTestId('media-progress-tiles')).toBeNull();
  });
});
