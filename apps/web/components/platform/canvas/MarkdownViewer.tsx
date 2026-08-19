'use client';

import hljs from 'highlight.js';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

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

// An artifact body sometimes wraps a full Markdown document in a fenced block
// — tagged ```markdown, tagged with something that isn't a real recognized
// programming language, or with no language tag at all. Rendering any of
// those through the default pre/code path would leave the literal #/**/|
// characters visible as plain text. Only genuinely recognized programming
// languages get the code treatment; everything else is far more likely to be
// prose that landed in a fence, so render it as Markdown instead.
function PreBlock({ node, children, ...props }: React.HTMLAttributes<HTMLPreElement> & { node?: HastPreNode }) {
  const { language, text } = getFencedCodeInfo(node);
  const isRecognizedCodeLanguage = !!language && language !== 'markdown' && language !== 'md' && !!hljs.getLanguage(language);

  if (!isRecognizedCodeLanguage && text.trim() !== '') {
    return (
      <div className="mb-3">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownViewerComponents}>
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

const markdownViewerComponents: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0 break-words">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-outside ml-4 mb-3 space-y-1 break-words">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-outside ml-4 mb-3 space-y-1 break-words">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  pre: PreBlock as Components['pre'],
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
};

export function MarkdownViewer({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownViewerComponents}>
      {content}
    </ReactMarkdown>
  );
}
