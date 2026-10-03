import { describe, it, expect } from 'vitest';
import { parseListPage, MAX_LIST_LIMIT } from './files.listPage';

describe('parseListPage', () => {
  it('defaults to 50 from offset 0', () => {
    expect(parseListPage(undefined, undefined)).toEqual({ limit: 50, offset: 0 });
  });

  it('lets a caller ask for a bigger page', () => {
    expect(parseListPage('500', '1000')).toEqual({ limit: 500, offset: 1000 });
  });

  it('caps the page so one request cannot pull a whole tenant', () => {
    expect(parseListPage('100000', '0').limit).toBe(MAX_LIST_LIMIT);
  });

  it('falls back to the defaults on junk or non-positive input', () => {
    expect(parseListPage('abc', 'xyz')).toEqual({ limit: 50, offset: 0 });
    expect(parseListPage('0', '-5')).toEqual({ limit: 50, offset: 0 });
  });
});
