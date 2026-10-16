import { describe, it, expect } from 'vitest';
import { parseBrandSource } from '../lib/brandSource';

describe('parseBrandSource', () => {
  it.each([
    ['@mamaearth.in', 'mamaearth.in'],
    ['mamaearth_in', 'mamaearth_in'],
    ['https://www.instagram.com/mamaearth.in/?hl=en', 'mamaearth.in'],
    ['instagram.com/Pilgrim', 'pilgrim'],
  ])('reads %s as Instagram', (value, handle) => {
    expect(parseBrandSource(value)).toEqual({ type: 'instagram', handle });
  });

  it.each([
    ['https://mamaearth.in', 'https://mamaearth.in/'],
    ['mamaearth.in', 'https://mamaearth.in/'],
    ['http://shop.example.com/x', 'https://shop.example.com/x'],
  ])('reads %s as a website', (value, url) => {
    expect(parseBrandSource(value)).toEqual({ type: 'website', url });
  });

  it.each(['', '   ', 'hello world', 'ftp://x.com', '@', 'https://instagram.com/'])('rejects %j', (value) => {
    expect(parseBrandSource(value)).toBeNull();
  });

  it.each([
    'https://www.instagram.com/p/Cabc123/',
    'https://instagram.com/reel/Cabc123/',
    'https://instagram.com/reels/Cabc123/',
    'https://instagram.com/explore/tags/mamaearth/',
    'https://instagram.com/accounts/login/',
    'https://instagram.com/stories/mamaearth.in/',
    'https://instagram.com/tv/Cabc123/',
    'https://instagram.com/direct/inbox/',
  ])('rejects Instagram route %s, not a profile', (value) => {
    expect(parseBrandSource(value)).toBeNull();
  });
});
