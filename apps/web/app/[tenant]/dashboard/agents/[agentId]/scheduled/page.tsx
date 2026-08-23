"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, AlertCircle, CalendarClock, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AgentDetail } from "@/components/platform/agents/types";
import { relayGet, relayDelete, type SchedulesResponse } from "./orchestratorClient";
import { NewScheduleDialog } from "./NewScheduleDialog";

function formatNextFire(ts: number): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(ts)
  );
}

export default function ScheduledPage() {
  const params = useParams();
  const agentId = params.agentId as string;
  const tenantSlug = params.tenant as string;
  const queryClient = useQueryClient();

  const { data: agent, isLoading: isLoadingAgent } = useQuery({
    queryKey: ["agents", agentId],
    queryFn: () => api.get<AgentDetail>(`/api/v1/agents/${agentId}`),
  });

  const { data, isLoading, isError, error } = useQuery<SchedulesResponse>({
    queryKey: ["schedules", agentId],
    queryFn: () => relayGet<SchedulesResponse>("/schedules", agentId),
  });

  const deleteMutation = useMutation({
    mutationFn: (scheduleId: string) => relayDelete(`/schedules/${scheduleId}`, agentId),
    onSuccess: () => {
      toast.success("Schedule deleted");
      queryClient.invalidateQueries({ queryKey: ["schedules", agentId] });
    },
    onError: (err: Error) => toast.error(`Failed to delete: ${err.message}`),
  });

  const schedules = data?.schedules ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["schedules", agentId] });

  return (
    <PermissionGate resource="agents" action="read">
      <div className="space-y-8">
        <div className="space-y-4">
          <Link
            href={`/${tenantSlug}/dashboard/agents/${agentId}`}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to {isLoadingAgent ? "Agent" : (agent?.name ?? "Agent")}
          </Link>

          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
                <CalendarClock className="h-7 w-7" />
                Duties
              </h1>
              <p className="text-muted-foreground mt-1">
                Tasks this teammate runs automatically, on a schedule you set.
              </p>
            </div>
            <NewScheduleDialog agentId={agentId} onCreated={invalidate} />
          </div>
        </div>

        {isError && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Failed to load schedules</AlertTitle>
            <AlertDescription>
              {error instanceof Error ? error.message : "Unknown error"}
            </AlertDescription>
          </Alert>
        )}

        {!isError && (
          <div className="rounded-md border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Duty ID</TableHead>
                  <TableHead>Cron</TableHead>
                  <TableHead>Timezone</TableHead>
                  <TableHead>Next Due</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 3 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: 5 }).map((_, j) => (
                        <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : schedules.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="h-32 text-center text-muted-foreground">
                      No duties assigned yet. Give this teammate something to own — assign a duty and let them handle it on repeat.
                    </TableCell>
                  </TableRow>
                ) : (
                  schedules.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {s.id.length > 22 ? `${s.id.slice(0, 22)}…` : s.id}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary" className="font-mono">{s.cron}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{s.timezone}</TableCell>
                      <TableCell className="text-sm">{formatNextFire(s.nextFireAt)}</TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteMutation.mutate(s.id)}
                          disabled={deleteMutation.isPending && deleteMutation.variables === s.id}
                        >
                          {deleteMutation.isPending && deleteMutation.variables === s.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
