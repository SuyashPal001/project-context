// A rehype pass for the reply while it streams: each word becomes its own
// span, so a word fades in when it arrives (see .stream-word in globals.css).
// React keys the generated nodes by position, so words already on screen keep
// their node and do not animate again; only the newly appended ones do.
// Code stays as it is — a span per token there would only cost nodes.

type HastNode = { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: HastNode[] };

const SKIP = new Set(['code', 'pre']);

function wrap(node: HastNode): void {
    if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
        if (child.type === 'text' && child.value) {
            // Keep the whitespace with the word before it, so spacing never moves.
            for (const word of child.value.match(/\S+\s*|\s+/g) ?? []) {
                next.push(/^\s+$/.test(word)
                    ? { type: 'text', value: word }
                    : { type: 'element', tagName: 'span', properties: { className: ['stream-word'] }, children: [{ type: 'text', value: word }] });
            }
        } else {
            wrap(child);
            next.push(child);
        }
    }
    node.children = next;
}

export function rehypeStreamWords() {
    return (tree: HastNode) => { wrap(tree); };
}
