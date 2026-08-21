'use client';

import { formatDistanceToNow } from 'date-fns';
import { ShieldAlert, ShieldCheck, Check, X, Terminal, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { ApprovalRequest } from './types';

interface ApprovalCardProps {
  request: ApprovalRequest;
  onApprove: () => void;
  onDismiss: () => void;
}

const DESTRUCTIVE_TOOLS = [
  'send_email',
  'delete',
  'update_member',
  'send_message',
  'delete_file',
  'archive_conversation',
  'kick_member',
  'cancel_subscription'
];

const TOOL_LABELS: Record<string, string> = {
  gmail_send_message:     'Send Email (Gmail)',
  calendar_create_event:  'Create Calendar Event',
  calendar_update_event:  'Update Calendar Event',
  zoho_mail_send_message: 'Send Email (Zoho)',
  zoho_cliq_send_message: 'Send Zoho Cliq Message',
  zoho_create_contact:    'Create CRM Contact',
  zoho_create_deal:       'Create CRM Deal',
  jira_create_issue:      'Create Jira Issue',
  jira_update_issue:      'Update Jira Issue',
};

function str(v: unknown, max?: number): string {
  if (v === undefined || v === null) return '—';
  const s = String(v);
  return max && s.length > max ? s.slice(0, max) + '…' : s;
}

function ArgRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-xs font-mono">
      <span className="text-muted-foreground shrink-0">{label}:</span>
      <span className="text-foreground break-all">{value}</span>
    </div>
  );
}

function KeyArgs({ toolName, args }: { toolName: string; args: Record<string, unknown> }) {
  if (toolName === 'gmail_send_message' || toolName === 'zoho_mail_send_message') {
    return (
      <>
        <ArgRow label="to"      value={str(args.to)} />
        <ArgRow label="subject" value={str(args.subject)} />
        <ArgRow label="body"    value={str(args.body, 100)} />
      </>
    );
  }
  if (toolName === 'calendar_create_event' || toolName === 'calendar_update_event') {
    const attendees = Array.isArray(args.attendees)
      ? args.attendees.map(a =>
          typeof a === 'string' ? a : str((a as Record<string, unknown>).email ?? a)
        ).join(', ')
      : str(args.attendees);
    return (
      <>
        <ArgRow label="summary"   value={str(args.summary)} />
        <ArgRow label="start"     value={str(args.start)} />
        <ArgRow label="attendees" value={attendees} />
      </>
    );
  }
  if (toolName === 'zoho_create_contact' || toolName === 'zoho_create_deal') {
    return (
      <>
        <ArgRow label="name"  value={str(args.name ?? args.Last_Name ?? args.Deal_Name)} />
        <ArgRow label="email" value={str(args.email ?? args.Email)} />
      </>
    );
  }
  if (toolName === 'jira_create_issue' || toolName === 'jira_update_issue') {
    return (
      <>
        <ArgRow label="summary"     value={str(args.summary)} />
        <ArgRow label="description" value={str(args.description, 100)} />
      </>
    );
  }
  return (
    <>
      {Object.entries(args).slice(0, 3).map(([k, v]) => (
        <ArgRow key={k} label={k} value={str(v)} />
      ))}
    </>
  );
}

export function ApprovalCard({ request, onApprove, onDismiss }: ApprovalCardProps) {
  const isDestructive = DESTRUCTIVE_TOOLS.includes(request.toolName);
  const isPending = request.status === 'pending';

  if (!isPending) {
    const isApproved = request.status === 'approved';
    return (
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-1 px-2 bg-muted/30 rounded-lg border border-border/20 w-fit">
        <Terminal className="h-3 w-3" />
        <span className="font-mono">{TOOL_LABELS[request.toolName] ?? request.toolName}</span>
        <span className="mx-1">·</span>
        <span className={cn(isApproved ? "text-green-500" : "text-red-500")}>
          {isApproved ? 'approved' : 'dismissed'} by you
        </span>
        <span className="mx-1">·</span>
        <span>{request.decisionAt ? formatDistanceToNow(new Date(request.decisionAt), { addSuffix: true }) : 'just now'}</span>
      </div>
    );
  }

  return (
    <div className="border border-border rounded-xl overflow-hidden bg-card shadow-card my-4 max-w-lg animate-in fade-in slide-in-from-bottom-2 duration-300">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={cn(
            "h-2 w-2 rounded-full animate-pulse",
            isDestructive ? "bg-red-500" : "bg-primary"
          )} />
          <h4 className="text-sm font-semibold">Approval needed before I continue</h4>
        </div>
        <Badge 
          variant="outline" 
          className={cn(
            "text-[10px] uppercase tracking-wider font-bold",
            isDestructive 
              ? "bg-red-500/10 text-red-500 border-red-500/20" 
              : "bg-green-500/10 text-green-500 border-green-500/20"
          )}
        >
          {isDestructive ? 'Irreversible' : 'Safe'}
        </Badge>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        <p className="text-sm text-foreground leading-relaxed">
          {request.description}
        </p>

        <div className="rounded-lg border border-border bg-muted/50 overflow-hidden">
          <div className="px-3 py-1.5 border-b border-border bg-muted flex items-center gap-2">
            <Terminal className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider font-bold">
              {TOOL_LABELS[request.toolName] ?? request.toolName}
            </span>
          </div>
          <div className="p-3 space-y-1.5 bg-background/50">
            <KeyArgs toolName={request.toolName} args={request.arguments} />
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-border bg-muted/10 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span>Agent paused</span>
        </div>
        <div className="flex items-center gap-2">
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-8 text-xs font-medium hover:bg-muted"
            onClick={onDismiss}
          >
            <X className="h-3 w-3 mr-1.5" />
            Dismiss
          </Button>
          <Button 
            variant={isDestructive ? "destructive" : "default"} 
            size="sm" 
            className="h-8 text-xs font-medium shadow-sm"
            onClick={onApprove}
          >
            <Check className="h-3 w-3 mr-1.5" />
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}
