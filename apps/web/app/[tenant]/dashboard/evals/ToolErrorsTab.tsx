"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface ToolRow {
  toolName: string;
  total: number;
  failures: number;
  errorRate: number;
  avgLatencyMs: number;
}

interface ErrorsResponse {
  data: { tools: ToolRow[]; period: { days: number; from: string } };
}

function ErrorRateBadge({ rate }: { rate: number }) {
  const color =
    rate === 0 ? "border-emerald-500/30 text-emerald-400" :
    rate < 5   ? "border-amber-500/30 text-amber-400" :
                 "border-red-500/30 text-red-400";
  return (
    <Badge variant="outline" className={cn("font-mono text-xs", color)}>
      {rate.toFixed(1)}%
    </Badge>
  );
}

async function downloadCsv(days: number) {
  const res = await fetch(`/api/proxy/api/v1/evals/export?days=${days}`);
  const text = await res.text();
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `usage-report-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function ToolErrorsTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<ErrorsResponse>({
    queryKey: ["evals-errors", days],
    queryFn: () => api.get(`/api/v1/evals/errors?days=${days}`),
  });

  const tools = data?.data?.tools ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Tool call success and failure rates for the last {days} days.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          onClick={() => downloadCsv(days)}
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      ) : tools.length === 0 ? (
        <div className="py-16 text-center text-sm text-muted-foreground">
          No tool calls recorded in this period.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Tool</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Calls</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Failures</th>
                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Error Rate</th>
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Avg Latency</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {tools.map((row) => (
                <tr key={row.toolName} className="hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs text-foreground/80">{row.toolName}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{row.total.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{row.failures}</td>
                  <td className="px-4 py-3">
                    <ErrorRateBadge rate={row.errorRate} />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                    {row.avgLatencyMs.toLocaleString()} ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
