import { describe, it, expect } from 'vitest';
import { groupImageToolCalls, isImageTileTool } from './ToolCallCard';

describe('isImageTileTool', () => {
  it('matches direct image tools and the Director delegate wrapper', () => {
    expect(isImageTileTool('generate_image')).toBe(true);
    expect(isImageTileTool('generate-image')).toBe(true);
    expect(isImageTileTool('edit_image')).toBe(true);
    expect(isImageTileTool('agent-director')).toBe(true);
    expect(isImageTileTool('agent_director')).toBe(true);
  });

  it('does not match unrelated tools, including other media types', () => {
    expect(isImageTileTool('web_search')).toBe(false);
    expect(isImageTileTool('generate_video')).toBe(false);
    expect(isImageTileTool('generate_song')).toBe(false);
    expect(isImageTileTool('agent-producer')).toBe(false);
  });
});

describe('groupImageToolCalls', () => {
  it('groups consecutive image-generation rows into one array', () => {
    const items = [
      { id: '1', toolName: 'generate_image' },
      { id: '2', toolName: 'generate_image' },
      { id: '3', toolName: 'generate_image' },
      { id: '4', toolName: 'generate_image' },
    ];
    const groups = groupImageToolCalls(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(4);
  });

  it('keeps non-image rows and non-adjacent image rows as singleton groups', () => {
    const items = [
      { id: '1', toolName: 'web_search' },
      { id: '2', toolName: 'generate_image' },
      { id: '3', toolName: 'generate_image' },
      { id: '4', toolName: 'retrieve_documents' },
      { id: '5', toolName: 'generate_image' },
    ];
    const groups = groupImageToolCalls(items);
    expect(groups).toHaveLength(4);
    expect(groups.map(g => g.length)).toEqual([1, 2, 1, 1]);
    expect(groups[0][0].id).toBe('1');
    expect(groups[1].map(t => t.id)).toEqual(['2', '3']);
    expect(groups[2][0].id).toBe('4');
    expect(groups[3][0].id).toBe('5');
  });

  it('groups Director delegate calls together with plain generate_image calls', () => {
    const items = [
      { id: '1', toolName: 'agent-director' },
      { id: '2', toolName: 'agent-director' },
    ];
    const groups = groupImageToolCalls(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('returns an empty array for an empty input', () => {
    expect(groupImageToolCalls([])).toEqual([]);
  });
});
