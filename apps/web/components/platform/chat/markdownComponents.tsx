import hljs from 'highlight.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

// hast node types as passed by react-markdown to custom components via `node`.
interface HastCodeNode {
    tagName?: string;
    properties?: { className?: string[] };
    children?: Array<{ value?: string }>;
}
interface HastPreNode {
    children?: HastCodeNode[];
}

function getFencedCodeInfo(node: HastPreNode | undefined) {
    const codeNode = node?.children?.find((child) => child.tagName === 'code');
    const className = codeNode?.properties?.className?.join(' ') ?? '';
    const language = /language-(\w+)/.exec(className)?.[1];
    const text = codeNode?.children?.map((child) => child.value ?? '').join('') ?? '';
    return { language, text };
}

// A model that intends a full Markdown document (headings, bold, tables) to
// render as formatted content sometimes wraps it in a fenced block — tagged
// ```markdown, tagged with something hljs doesn't recognize as real code, or
// with no language tag at all. Rendering any of those through PreBlock's
// default (syntax-highlighted, monospace) path would leave the literal
// #/**/| characters visible, just colored. Only genuinely recognized
// programming languages should get the code/hljs treatment; everything else
// is far more likely to be prose that happened to land in a fence, so render
// it as Markdown instead.
function PreBlock({ node, children, ...props }: React.HTMLAttributes<HTMLPreElement> & { node?: HastPreNode }) {
    const { language, text } = getFencedCodeInfo(node);
    const isRecognizedCodeLanguage = !!language && language !== 'markdown' && language !== 'md' && !!hljs.getLanguage(language);

    if (!isRecognizedCodeLanguage && text.trim() !== '') {
        return (
            <div className="mb-3">
                <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
                    {text}
                </ReactMarkdown>
            </div>
        );
    }

    return (
        <pre className="bg-muted p-4 rounded-lg overflow-x-auto mb-3 text-sm font-mono" {...props}>
            {children}
        </pre>
    );
}

function CodeBlock({ className, children, ...props }: React.HTMLAttributes<HTMLElement>) {
    const codeString = String(children).replace(/\n$/, '');

    if (!className) {
        return (
            <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>
                {children}
            </code>
        );
    }

    const language = /language-(\w+)/.exec(className)?.[1];
    const result = language && hljs.getLanguage(language)
        ? hljs.highlight(codeString, { language })
        : hljs.highlightAuto(codeString);

    return (
        <code
            className={cn('hljs', className)}
            dangerouslySetInnerHTML={{ __html: result.value }}
            {...props}
        />
    );
}

export const chatMarkdownComponents: Components = {
    p: ({ children }) => <p className="mb-3 last:mb-0 break-words">{children}</p>,
    ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1 break-words">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1 break-words">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    pre: PreBlock as Components['pre'],
    code: CodeBlock as Components['code'],
    h1: ({ children }) => <h1 className="font-semibold mb-2 mt-4 text-lg">{children}</h1>,
    h2: ({ children }) => <h2 className="font-semibold mb-2 mt-4 text-base">{children}</h2>,
    h3: ({ children }) => <h3 className="font-semibold mb-2 mt-4 text-sm">{children}</h3>,
    a: ({ href, children }) => <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>,
    blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 italic mb-3">{children}</blockquote>,
    table: ({ children }) => (
        <div className="overflow-x-auto mb-3">
            <table className="w-full text-sm border-collapse">{children}</table>
        </div>
    ),
    thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
    tr: ({ children }) => <tr className="border-b border-border last:border-0">{children}</tr>,
    th: ({ children }) => <th className="text-left font-semibold px-3 py-2">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2 align-top">{children}</td>,
};
