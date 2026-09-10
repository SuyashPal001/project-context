"use client";

import { useState } from "react";
import { ShieldAlert, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

// Mirrors the tool-friendly-name convention in
// components/platform/chat/ApprovalCard.tsx's TOOL_LABELS — kept as a
// separate, smaller map here since this card only needs to label a tool
// name, not render its call arguments (the workflow step hasn't been
// executed yet at suspend time, so there are no arguments to show).
const TOOL_LABELS: Record<string, string> = {
  gmail_send_message: "Send Email (Gmail)",
  calendar_create_event: "Create Calendar Event",
  calendar_update_event: "Update Calendar Event",
  zoho_mail_send_message: "Send Email (Zoho)",
  jira_create_issue: "Create Jira Issue",
  jira_update_issue: "Update Jira Issue",
};

interface WorkflowStepApprovalCardProps {
  runId: string;
  pendingApproval: { stepId: string; title: string; toolName: string; reason: string };
}

export function WorkflowStepApprovalCard({ runId, pendingApproval }: WorkflowStepApprovalCardProps) {
  const [isSubmitting, setIsSubmitting] = useState<"approve" | "decline" | null>(null);
  const queryClient = useQueryClient();

  const decide = async (approved: boolean) => {
    setIsSubmitting(approved ? "approve" : "decline");
    try {
      await api.put(`/api/v1/agent-runs/${runId}/approve`, { approved });
      await queryClient.invalidateQueries({ queryKey: ["agent-runs"] });
    } catch {
      toast.error(approved ? "Could not approve this step. Please try again." : "Could not decline this step. Please try again.");
    } finally {
      setIsSubmitting(null);
    }
  };

  return (
    <div className="border border-amber-500/30 rounded-xl overflow-hidden bg-card shadow-card">
      <div className="px-4 py-3 border-b border-amber-500/20 bg-amber-500/5 flex items-center gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-500" />
        <h4 className="text-sm font-semibold">Approval needed to continue this run</h4>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-sm text-foreground">{pendingApproval.title}</p>
        <Badge variant="outline" className="text-[10px] font-mono uppercase tracking-wider">
          {TOOL_LABELS[pendingApproval.toolName] ?? pendingApproval.toolName}
        </Badge>
      </div>
      <div className="px-4 py-3 border-t border-amber-500/20 bg-muted/10 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={isSubmitting !== null} onClick={() => decide(false)}>
          {isSubmitting === "decline" ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <X className="h-3 w-3 mr-1.5" />}
          Decline
        </Button>
        <Button variant="default" size="sm" disabled={isSubmitting !== null} onClick={() => decide(true)}>
          {isSubmitting === "approve" ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : <Check className="h-3 w-3 mr-1.5" />}
          Approve
        </Button>
      </div>
    </div>
  );
}
