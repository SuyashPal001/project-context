"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

interface ByAgent {
  agentId: string;
  agentName: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  conversations: number;
}

interface ByModel {
  model: string | null;
  messageCount: number;
  totalTokens: number;
}

interface TokensResponse {
  data: {
    byAgent: ByAgent[];
    byModel: ByModel[];
    period: { days: number; from: string };
  };
}

function fmt(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function TokenUsageTab({ days }: { days: number }) {
  const { data, isLoading } = useQuery<TokensResponse>({
    queryKey: ["evals-tokens", days],
    queryFn: () => api.get(`/api/v1/evals/tokens?days=${days}`),
  });

  const byAgent = data?.data?.byAgent ?? [];
  const byModel = data?.data?.byModel ?? [];

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* By Agent */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          By Agent
        </h3>
        {byAgent.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No data for this period.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Agent</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Convs</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Input</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Output</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Total</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byAgent.map((row) => (
                  <tr key={row.agentId} className="hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-3 font-medium text-foreground/90">{row.agentName}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{row.conversations}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">{fmt(row.inputTokens)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">{fmt(row.outputTokens)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-foreground/80">{fmt(row.totalTokens)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-emerald-500">${row.totalCost.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* By Model */}
      <div>
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          By Mind
        </h3>
        {byModel.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No data for this period.</p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr>
                  <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Mind</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Messages</th>
                  <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Tokens</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {byModel.map((row) => (
                  <tr key={row.model ?? "unknown"} className="hover:bg-muted/10 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-foreground/80">{row.model ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-muted-foreground">{row.messageCount.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-semibold text-foreground/80">{fmt(row.totalTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
