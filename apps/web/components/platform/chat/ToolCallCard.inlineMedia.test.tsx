/** @vitest-environment jsdom */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ToolCallCard, extractResultFiles } from './ToolCallCard';

afterEach(() => cleanup());

describe('extractResultFiles', () => {
  it('reads a single-item generate_image result', () => {
    const files = extractResultFiles('generate_image', { fileId: 'f1', name: 'a.png', fileType: 'image/png', size: 10 });
    expect(files).toEqual([{ fileId: 'f1', name: 'a.png', fileType: 'image/png', size: 10 }]);
  });

  it('reads a batch generate_images result.results array', () => {
    const files = extractResultFiles('generate_images', {
      results: [
        { fileId: 'f1', name: 'a.png', fileType: 'image/png', index: 0 },
        { fileId: 'f2', name: 'b.png', fileType: 'image/png', index: 1 },
        { insufficientCredits: true, index: 2 },
      ],
    });
    expect(files.map(f => f.fileId)).toEqual(['f1', 'f2']);
  });

  it('reads a show_files result.files array', () => {
    const files = extractResultFiles('show_files', {
      files: [{ fileId: 'f1', name: 'a.png', fileType: 'image/png', size: 5 }],
      missing: [],
    });
    expect(files.map(f => f.fileId)).toEqual(['f1']);
  });

  it('returns empty for a failed/refused result', () => {
    expect(extractResultFiles('generate_image', { refused: true, refusalReason: 'SAFETY' })).toEqual([]);
  });

  it('reads the images a delegate made and showed, once each', () => {
    const files = extractResultFiles('agent-director', {
      text: 'Here is the storyboard',
      subAgentToolResults: [
        { toolName: 'skill', result: '## rules' },
        { toolName: 'generate_image', result: { fileId: 'b1', name: 'Beat 1.png', fileType: 'image/png' } },
        { toolName: 'generate_images', result: { results: [{ fileId: 'b2', name: 'Beat 2.png', fileType: 'image/png' }] } },
        { toolName: 'show_files', result: { files: [{ fileId: 'b1', name: 'Beat 1.png', fileType: 'image/png' }] } },
      ],
    });
    expect(files.map(f => f.fileId)).toEqual(['b1', 'b2']);
  });

  it('reads the narration a delegate made, so it hangs under the Voice step', () => {
    const files = extractResultFiles('agent-director', {
      subAgentToolResults: [
        { toolName: 'generate_narration', result: { fileId: 'n1', name: 'Generated Narration.wav', fileType: 'audio/wav', size: 9 } },
      ],
    });
    expect(files).toEqual([{ fileId: 'n1', name: 'Generated Narration.wav', fileType: 'audio/wav', size: 9 }]);
    expect(extractResultFiles('generate_narration', { refused: true, refusalReason: 'GENERATION_FAILED' })).toEqual([]);
  });

  it('returns empty for a non-media, non-show_files tool', () => {
    expect(extractResultFiles('web_search', { fileId: 'f1' })).toEqual([]);
  });
});

describe('ToolCallCard inline media on completion', () => {
  it('renders the generated image inline immediately once the tool call is done, using freshUrls', () => {
    render(
      <ToolCallCard
        toolName="generate_image"
        query=""
        status="done"
        result={{ fileId: 'f1', name: 'a.png', fileType: 'image/png' }}
        freshUrls={{ f1: 'https://example.com/a.png' }}
      />
    );
    const img = screen.getByRole('img', { name: 'a.png' }) as HTMLImageElement;
    expect(img.src).toBe('https://example.com/a.png');
  });

  it('renders a placeholder tile (no <img>) before the presigned URL has arrived', () => {
    render(
      <ToolCallCard
        toolName="generate_image"
        query=""
        status="done"
        result={{ fileId: 'f1', name: 'a.png', fileType: 'image/png' }}
        freshUrls={{}}
      />
    );
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByTestId('inline-media-card')).toBeTruthy();
  });

  it('does not render inline media for a failed generation', () => {
    render(
      <ToolCallCard
        toolName="generate_image"
        query=""
        status="done"
        result={{ refused: true, refusalReason: 'SAFETY' }}
        freshUrls={{ f1: 'https://example.com/a.png' }}
      />
    );
    expect(screen.queryByTestId('inline-media-card')).toBeNull();
  });
});
