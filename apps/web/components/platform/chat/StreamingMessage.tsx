'use client';

import { useEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatMarkdownComponents } from './markdownComponents';

interface StreamingMessageProps {
  isStreaming: boolean;
  content: string;
  isThinking?: boolean;
}

export function StreamingMessage({ isStreaming, content, isThinking }: StreamingMessageProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-scroll as content streams — 'nearest' only moves the scroll position
  // when the growing content has actually run past the visible area, instead
  // of 'end' which snaps the message flush against the bottom edge (the input
  // box) on every token even when the reply is short enough to need no
  // scrolling at all. This keeps the natural gap below short replies intact.
  useEffect(() => {
    if (contentRef.current && isStreaming) {
      contentRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [content, isStreaming]);

  if (isThinking && !content) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>Thinking...</span>
      </div>
    );
  }

  return (
    <div ref={contentRef}>
      <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={chatMarkdownComponents}
      >
          {content}
      </ReactMarkdown>
      {isStreaming && (
        <span className="inline-block w-2 h-4 bg-primary animate-pulse ml-1" />
      )}
    </div>
  );
}
