import { describe, it, expect } from 'vitest';
import { pageWindow } from './pageWindow';

describe('pageWindow', () => {
    it('shows every page when there are few', () => {
        expect(pageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
        expect(pageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
    it('shows the ends and the pages around the current one, with gaps', () => {
        expect(pageWindow(1, 55)).toEqual([1, 2, 3, 4, 5, 'gap', 55]);
        expect(pageWindow(20, 55)).toEqual([1, 'gap', 19, 20, 21, 'gap', 55]);
        expect(pageWindow(55, 55)).toEqual([1, 'gap', 51, 52, 53, 54, 55]);
    });
    it('shows a single skipped page instead of a gap', () => {
        expect(pageWindow(4, 55)).toEqual([1, 2, 3, 4, 5, 'gap', 55]);
        expect(pageWindow(5, 55)).toEqual([1, 'gap', 4, 5, 6, 'gap', 55]);
    });
});
