'use client';

import { useEffect, useRef, useState } from 'react';
import { FileText, Map, CheckSquare, Loader2, Check, AlertCircle, Pencil, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import type { ArtifactState, ArtifactType } from './types';

interface ArtifactPanelProps {
  artifact: ArtifactState;
  onApprove: () => Promise<void>;
  onRevise?: (instructions: string) => Promise<void>;
  onContentLoaded: (content: string) => void;
  tenantSlug?: string;
}

const TYPE_ICONS: Record<ArtifactType, React.ReactNode> = {
  prd:     <FileText className="h-4 w-4" />,
  roadmap: <Map className="h-4 w-4" />,
  tasks:   <CheckSquare className="h-4 w-4" />,
};

const APPROVE_LABELS: Record<ArtifactType, string> = {
  prd:     'Approve PRD',
  roadmap: 'Approve Roadmap',
  tasks:   'Confirm Tasks',
};

function metaLabel(artifact: ArtifactState): string {
  const m = artifact.entityMeta;
  if (!m) return '';
  switch (artifact.type) {
    case 'prd':     return `Draft v${m.version ?? 1}`;
    case 'roadmap': return `${m.milestoneCount ?? 0} milestone${m.milestoneCount === 1 ? '' : 's'}`;
    case 'tasks':   return `${m.tasksCreated ?? 0} task${m.tasksCreated === 1 ? '' : 's'}`;
  }
}

function MarkdownLine({ line }: { line: string }) {
  if (line.startsWith('# ')) {
    return <p className="font-bold text-base text-foreground mt-3 mb-0.5">{line.slice(2)}</p>;
  }
  if (line.startsWith('## ')) {
    return <p className="font-semibold text-sm text-foreground mt-2 mb-0.5">{line.slice(3)}</p>;
  }
  if (line.startsWith('- ') || line.startsWith('* ')) {
    return (
      <div className="flex gap-2 pl-3">
        <span className="text-muted-foreground shrink-0">•</span>
        <span>{line.slice(2)}</span>
      </div>
    );
  }
  if (line === '') return <div className="h-1.5" />;
  return <p>{line}</p>;
}

export function ArtifactPanel({ artifact, onApprove, onRevise, onContentLoaded, tenantSlug }: ArtifactPanelProps) {

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showRevise, setShowRevise] = useState(false);
  const [reviseText, setReviseText] = useState('');
  const showFooter = !artifact.isStreaming && artifact.entityId !== null;

  // Fetch PRD content from DB when artifact has no content (post-refresh restore)
  useEffect(() => {
    if (!artifact.entityId || artifact.isStreaming || artifact.content) return;
    if (artifact.type === 'prd') {
      api.get<{ data: { content: string } }>(`/api/v1/prds/${artifact.entityId}`)
        .then(res => { const c = res.data?.content; if (typeof c === 'string' && c) onContentLoaded(c); })
        .catch(() => {});
    } else if (artifact.type === 'roadmap') {
      Promise.all([
        api.get<{ data: { title: string; description?: string | null } }>(`/api/v1/plans/${artifact.entityId}`),
        api.get<{ data: Array<{ title: string; description?: string | null; priority: string }> }>(`/api/v1/plans/${artifact.entityId}/milestones`),
      ]).then(([planRes, msRes]) => {
        const plan = planRes.data;
        const milestones = msRes.data ?? [];
        const lines: string[] = [`# ${plan.title}`];
        if (plan.description) lines.push(`\n${plan.description}\n`);
        if (milestones.length > 0) {
          lines.push('## Milestones\n');
          milestones.forEach((m, i) => {
            lines.push(`### ${i + 1}. ${m.title}`);
            lines.push(`**Priority:** ${m.priority}`);
            if (m.description) lines.push(`\n${m.description}`);
            lines.push('');
          });
        }
        onContentLoaded(lines.join('\n'));
      }).catch(() => {});
    }
  }, [artifact.entityId, artifact.isStreaming, artifact.type]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll to bottom as content streams in
  useEffect(() => {
    if (scrollRef.current && artifact.isStreaming) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [artifact.content.length, artifact.isStreaming]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex-none flex items-center gap-2.5 px-4 py-3 border-b border-border">
        <span className="text-muted-foreground">{TYPE_ICONS[artifact.type]}</span>
        <span className="flex-1 text-sm font-semibold truncate">{artifact.title}</span>
        {artifact.isStreaming ? (
          <Badge variant="outline" className="text-[10px] border-primary/30 text-primary gap-1.5 animate-pulse">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            Generating…
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px] border-green-500/30 text-green-500">
            Ready to review
          </Badge>
        )}
      </div>

      {/* Scrollable content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 text-sm text-foreground/90 leading-relaxed"
      >
        {artifact.content.split('\n').map((line, i) => (
          <MarkdownLine key={i} line={line} />
        ))}
        {artifact.isStreaming && (
          <span className="inline-block w-0.5 h-4 bg-primary animate-pulse ml-0.5 align-middle" />
        )}
      </div>

      {/* Footer — only shown when streaming is done and entity saved */}
      {showFooter && (
        <div className="flex-none border-t border-border bg-muted/10">
          {/* Revision textarea — shown when Request Changes is clicked */}
          {showRevise && (
            <div className="flex flex-col gap-2 px-4 pt-3 pb-2">
              <Textarea
                value={reviseText}
                onChange={e => setReviseText(e.target.value)}
                placeholder="Describe the changes you want…"
                className="text-xs resize-none h-20"
                autoFocus
              />
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => { setShowRevise(false); setReviseText(''); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!reviseText.trim() || artifact.approveStatus === 'loading'}
                  onClick={async () => {
                    const text = reviseText.trim();
                    setShowRevise(false);
                    setReviseText('');
                    await onRevise?.(text);
                  }}
                >
                  {artifact.approveStatus === 'loading'
                    ? <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Revising…</>
                    : 'Submit Changes'}
                </Button>
              </div>
            </div>
          )}

          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-[11px] text-muted-foreground">{metaLabel(artifact)}</span>
            <div className="flex items-center gap-2">
              {artifact.approveStatus === 'error' && (
                <span className="flex items-center gap-1 text-[11px] text-red-500">
                  <AlertCircle className="h-3 w-3" />
                  Failed — retry
                </span>
              )}
              {artifact.approveStatus === 'done' ? (
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-green-500 font-medium">
                    <Check className="h-3.5 w-3.5" />
                    {artifact.type === 'tasks' ? 'Confirmed' : 'Approved'}
                  </span>
                  {artifact.type === 'tasks' && artifact.entityId && tenantSlug && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-medium"
                      onClick={() => window.open(`/${tenantSlug}/dashboard/plans/${artifact.entityId}`, '_blank')}
                    >
                      View Plan
                      <ArrowRight className="h-3 w-3 ml-1.5" />
                    </Button>
                  )}
                </div>
              ) : (
                <>
                  {/* Request Changes — PRD only, only when HITL is active */}
                  {artifact.type === 'prd' && artifact.pmRunId && !showRevise && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-8 text-xs font-medium"
                      disabled={artifact.approveStatus === 'loading'}
                      onClick={() => setShowRevise(true)}
                    >
                      <Pencil className="h-3 w-3 mr-1.5" />
                      Request Changes
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="h-8 text-xs font-medium"
                    disabled={artifact.approveStatus === 'loading'}
                    onClick={onApprove}
                  >
                    {artifact.approveStatus === 'loading' ? (
                      <><Loader2 className="h-3 w-3 mr-1.5 animate-spin" />Working…</>
                    ) : (
                      APPROVE_LABELS[artifact.type]
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
