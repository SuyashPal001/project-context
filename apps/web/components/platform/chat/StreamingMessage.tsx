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
  //
  // Skipped entirely while content is still empty: this component mounts (and
  // this effect fires) the instant the assistant's placeholder row is
  // created, before any tokens have arrived — which is the same moment
  // MessageThread's own effect is running a deliberate, longer smooth scroll
  // to anchor the message the user just sent near the top of the pane. This
  // effect's scrollIntoView targets an empty div sitting right where that
  // scroll is trying to move away from, so it was winning the race and
  // snapping the view back down almost immediately, before the top-anchor
  // scroll ever got to finish. Waiting for real content removes the race.
  useEffect(() => {
    if (contentRef.current && isStreaming && content) {
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
