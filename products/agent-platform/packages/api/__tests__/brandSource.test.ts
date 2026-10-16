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
});
