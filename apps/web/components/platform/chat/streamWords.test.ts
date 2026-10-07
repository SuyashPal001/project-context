import { describe, it, expect } from 'vitest';
import { rehypeStreamWords } from './streamWords';

type Node = { type: string; tagName?: string; value?: string; children?: Node[] };

describe('rehypeStreamWords', () => {
    it('wraps each word with its trailing space, and leaves code alone', () => {
        const tree: Node = { type: 'root', children: [
            { type: 'element', tagName: 'p', children: [{ type: 'text', value: 'Done — the ad' }] },
            { type: 'element', tagName: 'pre', children: [{ type: 'element', tagName: 'code', children: [{ type: 'text', value: 'a b' }] }] },
        ] };
        rehypeStreamWords()(tree as never);
        const p = tree.children![0].children!;
        expect(p.map(n => n.children?.[0].value)).toEqual(['Done ', '— ', 'the ', 'ad']);
        expect(p.every(n => n.tagName === 'span')).toBe(true);
        expect(tree.children![1].children![0].children![0]).toEqual({ type: 'text', value: 'a b' });
    });
});
