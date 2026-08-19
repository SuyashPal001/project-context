import hljs from 'highlight.js';
import type { Components } from 'react-markdown';
import { cn } from '@/lib/utils';

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
    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    pre: ({ children }) => <pre className="bg-muted p-4 rounded-lg overflow-x-auto mb-3 text-sm font-mono">{children}</pre>,
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
