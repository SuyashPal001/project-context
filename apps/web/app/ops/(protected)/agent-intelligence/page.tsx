"use client";

import Link from "next/link";
import { MessageCircleQuestion, Star, Wrench, ChevronRight } from "lucide-react";

const SECTIONS = [
    {
        href: "/ops/agent-intelligence/knowledge-gaps",
        icon: MessageCircleQuestion,
        title: "Knowledge Gaps",
        description: "Questions agents couldn't answer due to missing RAG context. Review and address to improve agent quality.",
        accentColor: "text-amber-400",
        borderColor: "border-amber-500/20",
        bgColor: "bg-amber-500/5",
    },
    {
        href: "/ops/agent-intelligence/eval-scores",
        icon: Star,
        title: "Eval Scores",
        description: "Quality scores, RAG hit rates, and user feedback thumbs per tenant. Spot underperforming tenants.",
        accentColor: "text-primary",
        borderColor: "border-primary/20",
        bgColor: "bg-primary/5",
    },
    {
        href: "/ops/agent-intelligence/tool-performance",
        icon: Wrench,
        title: "Tool Performance",
        description: "Call counts, success rates, and average latency for every tool across all agents and tenants.",
        accentColor: "text-blue-400",
        borderColor: "border-blue-500/20",
        bgColor: "bg-blue-500/5",
    },
] as const;

export default function AgentIntelligencePage() {
    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-foreground">Agent Intelligence</h1>
                <p className="text-muted-foreground text-sm mt-1">Platform-wide visibility into agent quality, knowledge gaps, and tool behavior.</p>
            </div>

            <div className="grid grid-cols-1 gap-4">
                {SECTIONS.map(({ href, icon: Icon, title, description, accentColor, borderColor, bgColor }) => (
                    <Link
                        key={href}
                        href={href}
                        className={`flex items-start gap-4 p-5 rounded-xl border ${borderColor} ${bgColor} hover:bg-secondary/40 transition-colors group`}
                    >
                        <div className={`h-10 w-10 rounded-lg border ${borderColor} flex items-center justify-center flex-shrink-0`}>
                            <Icon className={`h-5 w-5 ${accentColor}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-base font-semibold ${accentColor}`}>{title}</p>
                            <p className="text-sm text-muted-foreground mt-1">{description}</p>
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground/80 group-hover:text-foreground/60 transition-colors flex-shrink-0 mt-1" />
                    </Link>
                ))}
            </div>
        </div>
    );
}
