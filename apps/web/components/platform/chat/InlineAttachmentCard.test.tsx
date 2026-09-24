/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { InlineAttachmentCard } from './InlineAttachmentCard';

afterEach(cleanup);

describe('InlineAttachmentCard media shape', () => {
  it('is 16:9 until the media loads', () => {
    render(<InlineAttachmentCard file={{ fileId: 'f', name: 'a.mp4', type: 'video/mp4' } as never} url="https://x/a.mp4" />);
    expect(screen.getByTestId('inline-media-card').className).toContain('aspect-video');
  });

  it('reshapes to a vertical video once its size is known', () => {
    const { container } = render(<InlineAttachmentCard file={{ fileId: 'f', name: 'a.mp4', type: 'video/mp4' } as never} url="https://x/a.mp4" />);
    const video = container.querySelector('video')!;
    Object.defineProperty(video, 'videoWidth', { value: 720 });
    Object.defineProperty(video, 'videoHeight', { value: 1280 });
    fireEvent.loadedMetadata(video);
    const card = screen.getByTestId('inline-media-card');
    expect(card.className).not.toContain('aspect-video');
    expect(card.className).toContain('w-[180px]');
    expect(card.style.aspectRatio).toBe(String(720 / 1280));
  });
});
