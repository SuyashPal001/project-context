'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        pre: ({ children }) => <pre className="bg-muted p-4 rounded-lg overflow-x-auto mb-3 text-sm font-mono">{children}</pre>,
        code: ({ className, children, ...props }: any) => !className
          ? <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono" {...props}>{children}</code>
          : <code className={className} {...props}>{children}</code>,
        h1: ({ children }) => <h1 className="font-bold text-base mb-2 mt-3">{children}</h1>,
        h2: ({ children }) => <h2 className="font-semibold text-sm mb-2 mt-3">{children}</h2>,
        h3: ({ children }) => <h3 className="font-semibold text-sm mb-1.5 mt-2">{children}</h3>,
        a: ({ href, children }) => <a href={href} className="text-primary underline" target="_blank" rel="noopener noreferrer">{children}</a>,
        blockquote: ({ children }) => <blockquote className="border-l-4 border-muted pl-4 italic mb-3">{children}</blockquote>,
        table: ({ children }) => <div className="overflow-x-auto mb-3"><table className="w-full text-left border-collapse">{children}</table></div>,
        thead: ({ children }) => <thead className="border-b border-border">{children}</thead>,
        th: ({ children }) => <th className="px-2 py-1.5 font-semibold text-xs">{children}</th>,
        td: ({ children }) => <td className="px-2 py-1.5 border-t border-border/50 text-xs">{children}</td>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
