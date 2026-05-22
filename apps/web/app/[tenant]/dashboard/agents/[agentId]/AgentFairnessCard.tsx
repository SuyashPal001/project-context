"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, ShieldAlert, ShieldX, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface CheckResult {
  checkId: string;
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface FairnessReview {
  id: string;
  overallStatus: "pass" | "warn" | "fail";
  checkResults: CheckResult[];
  runAt: string;
}

interface FairnessResponse {
  review: FairnessReview | null;
}

const statusConfig = {
  pass: { icon: ShieldCheck, color: "text-emerald-500", badge: "bg-emerald-500/10 text-emerald-500", label: "Passed" },
  warn: { icon: ShieldAlert, color: "text-yellow-500", badge: "bg-yellow-500/10 text-yellow-500", label: "Warning" },
  fail: { icon: ShieldX, color: "text-red-500", badge: "bg-red-500/10 text-red-500", label: "Failed" },
};

const checkStatusIcons = {
  pass: <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />,
  warn: <AlertTriangle className="h-4 w-4 text-yellow-500 shrink-0 mt-0.5" />,
  fail: <XCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />,
};

export function AgentFairnessCard({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<FairnessResponse>({
    queryKey: ["agent-fairness", agentId],
    queryFn: () => api.get<FairnessResponse>(`/api/v1/agents/${agentId}/fairness`),
  });

  const runMutation = useMutation({
    mutationFn: () => api.post<{ review: FairnessReview }>(`/api/v1/agents/${agentId}/fairness/run`, {}),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-fairness", agentId] });
      toast.success("Fairness check completed");
    },
    onError: () => toast.error("Fairness check failed"),
  });

  const review = data?.review ?? null;
  const overall = review ? statusConfig[review.overallStatus] : null;
  const OverallIcon = overall?.icon ?? ShieldCheck;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-muted-foreground" />
              Fairness Review
            </CardTitle>
            <CardDescription className="text-xs">
              RBI FREE-AI Sutra 1 — automated fairness checks on agent configuration
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending || isLoading}
          >
            {runMutation.isPending ? (
              <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Running…</>
            ) : "Run Check"}
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : !review ? (
          <p className="text-sm text-muted-foreground">No fairness check has been run yet. Click <span className="font-medium">Run Check</span> to evaluate this agent.</p>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <OverallIcon className={`h-5 w-5 ${overall?.color}`} />
              <div>
                <Badge variant="secondary" className={overall?.badge}>
                  {overall?.label}
                </Badge>
                <p className="text-xs text-muted-foreground mt-1">
                  Last run {new Date(review.runAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {review.checkResults.map((check) => (
                <div key={check.checkId} className="flex gap-2.5">
                  {checkStatusIcons[check.status]}
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium leading-none">{check.name}</p>
                    <p className="text-xs text-muted-foreground">{check.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
