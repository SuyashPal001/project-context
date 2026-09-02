'use client';

import { useState } from 'react';
import type { ToolCallSearchResult } from './types';
import { TYPE_STYLES, TYPE_BADGES } from '@/components/platform/canvas/assetTypeStyles';

interface ToolCallCardProps {
  toolName: string;
  query: string;
  status: 'loading' | 'done';
  results?: ToolCallSearchResult[];
}

// Director's tools are registered under the underscore key (generate_image,
// edit_image) — that's the raw toolName this component receives (unnormalized,
// unlike chatStream.ts's server-side gate). Matched loosely so a hyphenated
// form works too if a future caller normalizes before this point.
function isImageGenTool(toolName: string): boolean {
  return toolName === 'generate_image' || toolName === 'generate-image'
    || toolName === 'edit_image' || toolName === 'edit-image';
}

function ToolIcon({ toolName }: { toolName: string }) {
  const isSearch = toolName === 'web_search' || toolName === 'browser';
  const isDocs = toolName === 'retrieve_documents';
  const isEmail = toolName === 'gmail' || toolName === 'send_email' || toolName?.startsWith('GMAIL');
  const isDrive = toolName === 'google_drive';
  const isCRM = toolName === 'zoho_crm' || toolName?.startsWith('ZOHO_CRM');
  const isWriting = toolName === 'save-prd' || toolName === 'savePRD'
    || toolName === 'save-plan' || toolName === 'savePlan'
    || toolName === 'save-tasks' || toolName === 'saveTasks'
    || toolName?.startsWith('agent-prd') || toolName?.startsWith('agent-roadmap') || toolName?.startsWith('agent-task')
    || toolName?.startsWith('workflow-prd');
  const isImage = isImageGenTool(toolName);

  if (isImage) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="1.5" y="2.5" width="11" height="9" rx="1" stroke="currentColor" strokeWidth="1"/>
      <circle cx="5" cy="5.5" r="1" stroke="currentColor" strokeWidth="0.8"/>
      <path d="M2 10l3-3 2.5 2.5L11 6l1 1.5" stroke="currentColor" strokeWidth="1" fill="none" strokeLinejoin="round"/>
    </svg>
  );

  if (isSearch) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1"/>
      <ellipse cx="7" cy="7" rx="2.5" ry="5.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="1.5" y1="7" x2="12.5" y2="7" stroke="currentColor" strokeWidth="1"/>
      <line x1="2" y1="4.5" x2="12" y2="4.5" stroke="currentColor" strokeWidth="0.8"/>
      <line x1="2" y1="9.5" x2="12" y2="9.5" stroke="currentColor" strokeWidth="0.8"/>
    </svg>
  );

  if (isDocs) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="2.5" y="1.5" width="8" height="11" rx="1" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="4.5" x2="9.5" y2="4.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="6.5" x2="9.5" y2="6.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4.5" y1="8.5" x2="7.5" y2="8.5" stroke="currentColor" strokeWidth="1"/>
    </svg>
  );

  if (isEmail) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="1.5" y="3" width="11" height="8" rx="1" stroke="currentColor" strokeWidth="1"/>
      <polyline points="1.5,3.5 7,8 12.5,3.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isDrive) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <polygon points="7,1.5 13,12.5 1,12.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isCRM) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <circle cx="7" cy="5" r="2.5" stroke="currentColor" strokeWidth="1"/>
      <path d="M1.5 13c0-3.04 2.46-5.5 5.5-5.5s5.5 2.46 5.5 5.5" stroke="currentColor" strokeWidth="1" fill="none"/>
    </svg>
  );

  if (isWriting) return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <rect x="2" y="1.5" width="8" height="11" rx="1" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="4.5" x2="8" y2="4.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="6.5" x2="8" y2="6.5" stroke="currentColor" strokeWidth="1"/>
      <line x1="4" y1="8.5" x2="6.5" y2="8.5" stroke="currentColor" strokeWidth="1"/>
      <path d="M9 9.5l1.5-1.5 1.5 1.5-1.5 1.5z" stroke="currentColor" strokeWidth="0.8" fill="none"/>
    </svg>
  );

  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="opacity-60 shrink-0 text-current">
      <path d="M9.5 2A3.5 3.5 0 0 0 7 7.5L2.5 12a1.06 1.06 0 1 0 1.5 1.5L8.5 9A3.5 3.5 0 0 0 9.5 2z" stroke="currentColor" strokeWidth="1" fill="none"/>
      <circle cx="9.5" cy="4.5" r="0.75" fill="currentColor"/>
    </svg>
  );
}

function toolLabel(toolName: string, query: string, status: 'loading' | 'done'): { prefix: string; highlight: string } {
    const done = status === 'done';
    const q = query ? `"${query}"` : '';

    if (status === 'loading') {
        if (toolName === 'web_search') return { prefix: 'Searching the web for ', highlight: q };
        if (toolName === 'retrieve_documents') return { prefix: 'Searching your documents for ', highlight: q };
        if (toolName === 'browser') return { prefix: 'Browsing ', highlight: q };
        if (toolName === 'code_exec' || toolName === 'code_execution') return { prefix: 'Running code...', highlight: '' };
        if (toolName === 'save-prd' || toolName === 'savePRD' || toolName?.startsWith('agent-prd') || toolName?.startsWith('workflow-prd')) return { prefix: 'Writing PRD', highlight: query ? ` — ${q}` : '...' };
        if (toolName === 'save-plan' || toolName === 'savePlan' || toolName?.startsWith('agent-roadmap')) return { prefix: 'Building roadmap...', highlight: '' };
        if (toolName === 'save-tasks' || toolName === 'saveTasks' || toolName?.startsWith('agent-task')) return { prefix: 'Creating tasks...', highlight: '' };
        if (isImageGenTool(toolName)) return { prefix: toolName.includes('edit') ? 'Editing image...' : 'Generating image...', highlight: '' };
    }

    if (toolName === 'web_search' || toolName === 'browser') return { prefix: 'Searched the web for ', highlight: q };
    if (toolName === 'retrieve_documents') return { prefix: 'Read documents', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'GMAIL_READ' || toolName === 'gmail') return { prefix: done ? 'Checked Gmail' : 'Checking Gmail', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'GMAIL_SEND' || toolName === 'send_email') return { prefix: done ? 'Sent email to ' : 'Sending email to ', highlight: query };
    if (toolName === 'GCAL_CREATE_EVENT') return { prefix: done ? 'Created event' : 'Creating event', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('GCAL')) return { prefix: done ? 'Checked calendar' : 'Checking calendar', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_CRM')) return { prefix: done ? 'Accessed CRM' : 'Accessing CRM', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_MAIL')) return { prefix: done ? 'Sent email' : 'Sending email', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('ZOHO_CLIQ')) return { prefix: done ? 'Sent message' : 'Sending message', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('GMAIL')) return { prefix: done ? 'Accessed email' : 'Accessing email', highlight: query ? ` — ${q}` : '' };
    if (toolName?.startsWith('JIRA')) return { prefix: done ? 'Accessed Jira' : 'Accessing Jira', highlight: query ? ` — ${q}` : '' };
    if (toolName === 'code_execution' || toolName === 'code_exec') return { prefix: 'Ran code', highlight: '' };
    if (toolName === 'save-prd' || toolName === 'savePRD' || toolName?.startsWith('agent-prd') || toolName?.startsWith('workflow-prd')) return { prefix: 'PRD drafted', highlight: '' };
    if (toolName === 'save-plan' || toolName === 'savePlan' || toolName?.startsWith('agent-roadmap')) return { prefix: 'Roadmap built', highlight: '' };
    if (toolName === 'save-tasks' || toolName === 'saveTasks' || toolName?.startsWith('agent-task')) return { prefix: 'Tasks created', highlight: '' };
    if (isImageGenTool(toolName)) return { prefix: toolName.includes('edit') ? 'Image edited' : 'Image generated', highlight: '' };

    const friendly = toolName.replace(/_/g, ' ').toLowerCase();
    return { prefix: done ? `Used ${friendly}` : `Using ${friendly}`, highlight: query ? ` — ${q}` : '' };
}

const DOMAIN_PALETTE = [
  '#4f46e5', '#7c3aed', '#db2777', '#dc2626', '#d97706',
  '#16a34a', '#0284c7', '#0891b2', '#be185d', '#b45309',
];

function domainColor(domain: string): string {
  let h = 0;
  for (let i = 0; i < domain.length; i++) h = domain.charCodeAt(i) + ((h << 5) - h);
  return DOMAIN_PALETTE[Math.abs(h) % DOMAIN_PALETTE.length];
}

export function ToolCallCard({ toolName, query, status, results }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(true);
  const hasResults = status === 'done' && !!results?.length;
  const { prefix, highlight } = toolLabel(toolName, query, status);
  // Placeholder shaped like InlineAttachmentCard's own thumbnail chip, so the
  // real image swaps in without the layout jumping once it lands.
  const showImageSkeleton = status === 'loading' && isImageGenTool(toolName);

  return (
    <div className="my-1.5 text-foreground">
      <div
        className="flex items-center gap-2"
        style={{ cursor: hasResults ? 'pointer' : 'default' }}
        onClick={() => hasResults && setExpanded(e => !e)}
      >
        <ToolIcon toolName={toolName} />

        <span className={`text-sm font-semibold flex-1 truncate ${status === 'loading' ? 'shimmer-text' : ''}`}>
          {prefix}
          {highlight && (
            <span className="font-medium" style={{ color: 'var(--color-text-primary, inherit)' }}>
              {highlight}
            </span>
          )}
        </span>

        {status === 'loading' ? (
          <span className="flex gap-[3px] items-center shrink-0">
            <span className="h-[4px] w-[4px] rounded-full bg-muted-foreground animate-bounce [animation-delay:-0.3s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-muted-foreground opacity-60 animate-bounce [animation-delay:-0.15s]" />
            <span className="h-[4px] w-[4px] rounded-full bg-muted-foreground opacity-30 animate-bounce" />
          </span>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0 text-green-500">
              <path d="M2.5 7L5.5 10L11.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {hasResults && (
              <svg
                width="10" height="10" viewBox="0 0 10 10" fill="none"
                className={`shrink-0 transition-transform text-foreground ${expanded ? "rotate-90" : ""}`}
              >
                <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </>
        )}
      </div>

      {showImageSkeleton && (
        <div className={`relative mt-1.5 w-full max-w-[240px] aspect-video rounded-xl border border-border/60 overflow-hidden flex items-center justify-center ${TYPE_STYLES.image.bg}`}>
          <span className="absolute top-1.5 left-1.5 z-10 text-[9px] font-bold px-1.5 py-0.5 rounded bg-background/90 border border-border/60">
            {TYPE_BADGES.image}
          </span>
          <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-shimmer" />
        </div>
      )}

      {hasResults && expanded && (
        <div className="flex gap-2.5 mt-1.5 pl-0.5">
          <div className="w-3 shrink-0 border-l border-b border-border rounded-bl-md" style={{ marginTop: '-4px', height: '0.85em' }} />
          <div className="space-y-[5px] flex-1 min-w-0">
            {results!.slice(0, 3).map((r, i) => (
              <div key={i} className="flex items-center gap-2 min-w-0">
                <div
                  className="shrink-0 flex items-center justify-center select-none"
                  style={{
                    width: 14, height: 14, borderRadius: 2,
                    background: domainColor(r.domain),
                    color: '#fff', fontSize: 8, fontWeight: 700, lineHeight: 1,
                  }}
                >
                  {(r.favicon ?? r.domain.charAt(0)).toUpperCase()}
                </div>
                <span className="text-xs text-foreground truncate flex-1">{r.title}</span>
                <span className="text-xs text-muted-foreground shrink-0">{r.domain}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
