"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { formatDistanceToNow } from "date-fns";
import Link from "next/link";
import {
    Card,
    CardContent,
    CardHeader,
    CardTitle,
    CardDescription,
    CardFooter,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ThumbsUp, ThumbsDown, TrendingUp, Zap, Clock, DollarSign, Lock } from "lucide-react";
import { TokenUsageTab } from "./TokenUsageTab";
import { ToolErrorsTab } from "./ToolErrorsTab";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface EvalsSummary {
    totalConversations: number;
    avgQualityScore: number;
    ragHitRate: number;
    avgResponseTimeMs: number;
    totalTokens: number;
    totalCost: number;
    ratedMessages: number;
    thumbsUp: number;
    thumbsDown: number;
}

interface FeedbackMessage {
    messageId: string;
    conversationId: string;
    content: string;
    rating: "up" | "down";
    comment: string | null;
    feedbackAt: string;
}

interface ConversationMetric {
    id: string;
    conversationId: string;
    ragFired: boolean;
    ragChunksRetrieved: number;
    responseTimeMs: number | null;
    totalTokens: number;
    totalCostCents: number;
    userMessageCount: number;
    createdAt: string;
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({
    title,
    value,
    icon: Icon,
    sub,
    highlight,
}: {
    title: string;
    value: string;
    icon: React.ElementType;
    sub?: string;
    highlight?: "green" | "blue" | "amber";
}) {
    const colours = {
        green: "text-emerald-500",
        blue: "text-blue-500",
        amber: "text-amber-500",
    };
    return (
        <Card className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
                <Icon className={cn("h-4 w-4 text-muted-foreground", highlight && colours[highlight])} />
            </CardHeader>
            <CardContent>
                <div className={cn("text-2xl font-bold", highlight && colours[highlight])}>{value}</div>
                {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
            </CardContent>
        </Card>
    );
}

// ── Feedback table ────────────────────────────────────────────────────────────

function FeedbackTab() {
    const [filter, setFilter] = useState<"all" | "up" | "down">("all");

    const { data, isLoading } = useQuery<{ data: FeedbackMessage[] }>({
        queryKey: ["evals-messages", filter],
        queryFn: () =>
            api.get(`/api/v1/evals/messages${filter !== "all" ? `?rating=${filter}` : ""}`),
    });

    const rows = data?.data ?? [];

    return (
        <div className="space-y-4">
            <div className="flex gap-2">
                {(["all", "up", "down"] as const).map((f) => (
                    <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={cn(
                            "px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                            filter === f
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-transparent text-muted-foreground border-border hover:border-foreground/30"
                        )}
                    >
                        {f === "all" ? "All" : f === "up" ? "👍 Thumbs Up" : "👎 Thumbs Down"}
                    </button>
                ))}
            </div>

            {isLoading ? (
                <div className="space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full rounded-lg" />
                    ))}
                </div>
            ) : rows.length === 0 ? (
                <div className="py-16 text-center text-muted-foreground text-sm">
                    No feedback yet.
                </div>
            ) : (
                <div className="rounded-lg border border-border overflow-hidden">
                    <table className="w-full text-sm">
                        <thead className="bg-muted/30">
                            <tr>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Message</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-20">Rating</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Comment</th>
                                <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">When</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {rows.map((row) => (
                                <tr key={row.messageId} className="hover:bg-muted/10 transition-colors">
                                    <td className="px-4 py-3 max-w-xs">
                                        <p className="truncate text-foreground/80">
                                            {row.content.slice(0, 120)}{row.content.length > 120 ? "…" : ""}
                                        </p>
                                    </td>
                                    <td className="px-4 py-3">
                                        {row.rating === "up" ? (
                                            <ThumbsUp className="h-4 w-4 text-emerald-500 fill-current" />
                                        ) : (
                                            <ThumbsDown className="h-4 w-4 text-red-500 fill-current" />
                                        )}
                                    </td>
                                    <td className="px-4 py-3 text-muted-foreground text-xs">
                                        {row.comment ?? <span className="opacity-40">—</span>}
                                    </td>
                                    <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                                        {formatDistanceToNow(new Date(row.feedbackAt), { addSuffix: true })}
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

// ── Conversation metrics table ────────────────────────────────────────────────

function ConversationMetricsTab() {
    const { data, isLoading } = useQuery<{ data: ConversationMetric[] }>({
        queryKey: ["evals-conversations"],
        queryFn: () => api.get("/api/v1/evals/conversations"),
    });

    const rows = data?.data ?? [];

    return isLoading ? (
        <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
        </div>
    ) : rows.length === 0 ? (
        <div className="py-16 text-center text-muted-foreground text-sm">
            No conversation metrics yet. Metrics are written by the relay after each session.
        </div>
    ) : (
        <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
                <thead className="bg-muted/30">
                    <tr>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">Conversation</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-20">Messages</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">RAG fired</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-24">Tokens</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-20">Cost</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Response</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-28">Date</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                        <tr key={row.id} className="hover:bg-muted/10 transition-colors">
                            <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                {row.conversationId.slice(0, 8)}…
                            </td>
                            <td className="px-4 py-3 text-foreground/80">{row.userMessageCount}</td>
                            <td className="px-4 py-3">
                                {row.ragFired ? (
                                    <Badge variant="outline" className="text-emerald-500 border-emerald-500/30 bg-emerald-500/10 text-[10px]">
                                        Yes ({row.ragChunksRetrieved})
                                    </Badge>
                                ) : (
                                    <span className="text-muted-foreground text-xs">No</span>
                                )}
                            </td>
                            <td className="px-4 py-3 text-foreground/80">{row.totalTokens.toLocaleString()}</td>
                            <td className="px-4 py-3 text-foreground/80">
                                ${(row.totalCostCents / 100).toFixed(4)}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-xs">
                                {row.responseTimeMs != null ? `${row.responseTimeMs.toLocaleString()} ms` : "—"}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground text-xs whitespace-nowrap">
                                {formatDistanceToNow(new Date(row.createdAt), { addSuffix: true })}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EvalsPage() {
    const { tenantId, plan, slug } = useTenant();
    const isFree = plan.toLowerCase() === 'free';

    return (
        <PermissionGate resource="analytics" action="read">
            <EvalsPageContent tenantId={tenantId} plan={plan} isFree={isFree} slug={slug} />
        </PermissionGate>
    );
}

function EvalsPageContent({ tenantId, plan, isFree, slug }: { tenantId: string; plan: string; isFree: boolean; slug: string }) {
    const [days, setDays] = useState<7 | 30 | 90>(30);

    const { data: summary, isLoading } = useQuery<EvalsSummary>({
        queryKey: ["evals-summary", tenantId],
        queryFn: () => api.get("/api/v1/evals/summary"),
        staleTime: 60 * 1000,
        enabled: !isFree,
    });

    if (isFree) {
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <Card className="max-w-md w-full">
                    <CardHeader className="text-center">
                        <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                            <Lock className="w-6 h-6 text-primary" />
                        </div>
                        <CardTitle>Upgrade Required</CardTitle>
                        <CardDescription className="pt-2">
                            Evals are available on Starter, Business, and Enterprise plans. Upgrade now to unlock quality metrics and user feedback for your AI agents.
                        </CardDescription>
                    </CardHeader>
                    <CardFooter className="flex justify-center pb-8">
                        <Button asChild>
                            <Link href={`/${slug}/dashboard/billing`}>
                                View Plans & Upgrade
                            </Link>
                        </Button>
                    </CardFooter>
                </Card>
            </div>
        );
    }

    return (
        <div className="space-y-8">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Evals</h1>
                    <p className="text-muted-foreground mt-2">
                        Quality metrics and user feedback for your AI agents.
                    </p>
                </div>
                <div className="flex items-center gap-1 p-1 rounded-lg border border-border bg-muted/30">
                    {([7, 30, 90] as const).map((d) => (
                        <button
                            key={d}
                            onClick={() => setDays(d)}
                            className={cn(
                                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                                days === d ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {d}d
                        </button>
                    ))}
                </div>
            </div>

            {/* Metric cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {isLoading ? (
                    Array.from({ length: 4 }).map((_, i) => (
                        <Card key={i} className="bg-card">
                            <CardHeader className="pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
                            <CardContent><Skeleton className="h-8 w-16" /></CardContent>
                        </Card>
                    ))
                ) : (
                    <>
                        <MetricCard
                            title="Quality Score"
                            value={`${summary?.avgQualityScore ?? 0}%`}
                            icon={TrendingUp}
                            sub={`${summary?.thumbsUp ?? 0} up / ${summary?.thumbsDown ?? 0} down`}
                            highlight={(summary?.avgQualityScore ?? 0) >= 70 ? "green" : "amber"}
                        />
                        <MetricCard
                            title="RAG Hit Rate"
                            value={`${summary?.ragHitRate ?? 0}%`}
                            icon={Zap}
                            sub="Conversations that used RAG"
                            highlight="blue"
                        />
                        <MetricCard
                            title="Avg Response Time"
                            value={summary?.avgResponseTimeMs ? `${summary.avgResponseTimeMs.toLocaleString()} ms` : "—"}
                            icon={Clock}
                            sub="Across all conversations"
                        />
                        <MetricCard
                            title="Total Cost"
                            value={`$${(summary?.totalCost ?? 0).toFixed(2)}`}
                            icon={DollarSign}
                            sub={`${(summary?.totalTokens ?? 0).toLocaleString()} tokens`}
                        />
                    </>
                )}
            </div>

            {/* Tabs */}
            <Tabs defaultValue="feedback">
                <TabsList>
                    <TabsTrigger value="feedback">Feedback</TabsTrigger>
                    <TabsTrigger value="metrics">Conversations</TabsTrigger>
                    <TabsTrigger value="tokens">Token Usage</TabsTrigger>
                    <TabsTrigger value="errors">Tool Errors</TabsTrigger>
                </TabsList>
                <TabsContent value="feedback" className="mt-4">
                    <FeedbackTab />
                </TabsContent>
                <TabsContent value="metrics" className="mt-4">
                    <ConversationMetricsTab />
                </TabsContent>
                <TabsContent value="tokens" className="mt-4">
                    <TokenUsageTab days={days} />
                </TabsContent>
                <TabsContent value="errors" className="mt-4">
                    <ToolErrorsTab days={days} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
