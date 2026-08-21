"use client";

import { FileText, Map, ListChecks, Search, Lightbulb, PenLine, HelpCircle, type LucideIcon } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Button } from "@/components/ui/button";
import type { PillType } from "./WizardView";
import type { Agent } from "../agents/types";

const PM_PROMPTS: { icon: LucideIcon; label: string; pill: PillType }[] = [
    { icon: FileText,   label: "Write a PRD",      pill: "prd"      },
    { icon: Map,        label: "Build a roadmap",  pill: "roadmap"  },
    { icon: ListChecks, label: "Break into tasks",  pill: "tasks"    },
    { icon: Search,     label: "Research a topic",  pill: "research" },
];

const GENERAL_PROMPTS: { icon: LucideIcon; label: string; text: string }[] = [
    { icon: Lightbulb,   label: "Brainstorm ideas",     text: "Help me brainstorm ideas for " },
    { icon: PenLine,     label: "Draft something",      text: "Help me draft " },
    { icon: Search,      label: "Research a topic",     text: "Research and summarise " },
    { icon: HelpCircle,  label: "Explain a concept",    text: "Explain " },
];

interface WelcomeViewProps {
    agent: Agent | null;
    firstName: string;
    onSelectPill: (pill: PillType) => void;
    onSend: (text: string) => void;
    children: React.ReactNode;
}

export function WelcomeView({ agent, firstName, onSelectPill, onSend, children }: WelcomeViewProps) {
    const agentName = agent?.name ?? 'your assistant';
    const isPm = (agent?.name ?? '').toLowerCase().includes('pm');
    const tagline = agent?.description
        ?? (isPm ? 'I can help you plan, design, and ship.' : 'How can I help you today?');

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
                <div className="mb-6">
                    <AgentOrb size={64} state="idle" avatarUrl={agent?.avatarUrl} />
                </div>

                <h2 className="text-2xl font-bold tracking-tight mb-1">
                    Hi {firstName}! I&apos;m {agentName}.
                </h2>
                <p className="text-muted-foreground text-sm mb-8">{tagline}</p>

                <div className="flex flex-wrap gap-3 justify-center max-w-md">
                    {isPm
                        ? PM_PROMPTS.map(({ icon: Icon, label, pill }) => (
                            <Button key={pill} variant="outline"
                                className="gap-2 rounded-full px-5 py-2 h-auto text-sm font-medium bg-secondary/50 border-border/60 hover:bg-secondary hover:border-border transition-colors"
                                onClick={() => onSelectPill(pill)}
                            >
                                <Icon className="h-4 w-4 text-muted-foreground" /> {label}
                            </Button>
                        ))
                        : GENERAL_PROMPTS.map(({ icon: Icon, label, text }) => (
                            <Button key={label} variant="outline"
                                className="gap-2 rounded-full px-5 py-2 h-auto text-sm font-medium bg-secondary/50 border-border/60 hover:bg-secondary hover:border-border transition-colors"
                                onClick={() => onSend(text)}
                            >
                                <Icon className="h-4 w-4 text-muted-foreground" /> {label}
                            </Button>
                        ))
                    }
                </div>
            </div>

            <div className="shrink-0 pt-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                {children}
            </div>
        </div>
    );
}
