"use client";

import { FileText, Map, ListChecks, Search, Lightbulb, PenLine, HelpCircle, ImagePlus, Palette, Sparkles, LayoutTemplate, BarChart3, Code2, Building2, CalendarCheck2, ClipboardList, Settings, LifeBuoy, CreditCard, type LucideIcon } from "lucide-react";
import { AgentOrb } from "./AgentOrb";
import { Button } from "@/components/ui/button";
import type { PillType } from "./WizardView";
import type { Agent, AgentType } from "../agents/types";
import type { PersonaAnimationState } from "../personas/usePersonaAnimationState";
import { getPillIcon } from "./pillIcon";

// The real slugs of the two personas with bespoke pill behavior, looked up
// directly against the dev database rather than guessed — see
// docs/superpowers/specs/2026-09-05-agent-welcome-pills-design.md.
const DIRECTOR_PERSONA_SLUG = 'director';
const PM_PERSONA_SLUG = 'pm';

export interface PillClickContext {
    onSelectPill: (pill: PillType) => void;
    onSend: (text: string) => void;
}

export interface Pill {
    icon: LucideIcon;
    label: string;
    onClick: (ctx: PillClickContext) => void;
}

function textPill(icon: LucideIcon, label: string, text: string): Pill {
    return { icon, label, onClick: ({ onSend }) => onSend(text) };
}

function wizardPill(icon: LucideIcon, label: string, pill: PillType): Pill {
    return { icon, label, onClick: ({ onSelectPill }) => onSelectPill(pill) };
}

// PM's pills open a structured wizard flow, a fundamentally different
// mechanism from every other agent's plain-text-insert pills — kept
// hardcoded and untouched by the persona/type resolution below.
const PM_PROMPTS: Pill[] = [
    wizardPill(FileText, "Write a PRD", "prd"),
    wizardPill(Map, "Build a roadmap", "roadmap"),
    wizardPill(ListChecks, "Break into tasks", "tasks"),
    wizardPill(Search, "Research a topic", "research"),
];

const DIRECTOR_PROMPTS: Pill[] = [
    textPill(ImagePlus, "Generate an image", "Generate an image of "),
    textPill(Palette, "Create a logo", "Design a logo for "),
    textPill(LayoutTemplate, "Design a banner", "Create a banner for "),
    textPill(Sparkles, "Illustrate an idea", "Create an illustration of "),
];

const GENERAL_PROMPTS: Pill[] = [
    textPill(Lightbulb, "Brainstorm ideas", "Help me brainstorm ideas for "),
    textPill(PenLine, "Draft something", "Help me draft "),
    textPill(Search, "Research a topic", "Research and summarise "),
    textPill(HelpCircle, "Explain a concept", "Explain "),
];

// Covers a bare agent (no persona attached) whose *type* still carries
// signal — e.g. a custom-created "Analyst"-type agent with no persona hire.
// 'custom' is intentionally absent: a truly bare custom agent has no signal
// beyond a free-text name, and falls through to GENERAL_PROMPTS below.
const AGENT_TYPE_PROMPTS: Partial<Record<AgentType, Pill[]>> = {
    product_manager: [
        textPill(FileText, "Write a PRD", "Help me write a PRD for "),
        textPill(Map, "Build a roadmap", "Help me build a roadmap for "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
    ],
    analyst: [
        textPill(BarChart3, "Analyze data", "Analyze this data: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(FileText, "Summarize a report", "Summarize this report: "),
        textPill(Lightbulb, "Find insights", "Find insights in "),
    ],
    project_manager: [
        textPill(CalendarCheck2, "Plan a sprint", "Help me plan a sprint for "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(ClipboardList, "Track status", "Summarize the status of "),
        textPill(Search, "Research a topic", "Research and summarise "),
    ],
    tech_lead: [
        textPill(Code2, "Review a design", "Review this technical design: "),
        textPill(ListChecks, "Break into tasks", "Break this into engineering tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    architect: [
        textPill(Building2, "Design a system", "Help me design a system for "),
        textPill(Code2, "Review a design", "Review this technical design: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    ops: [
        textPill(Settings, "Automate a task", "Help me automate "),
        textPill(ListChecks, "Break into tasks", "Break this into tasks: "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    support: [
        textPill(LifeBuoy, "Draft a reply", "Help me draft a reply about "),
        textPill(PenLine, "Draft something", "Help me draft "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
    billing: [
        textPill(CreditCard, "Explain a charge", "Explain this charge: "),
        textPill(FileText, "Draft something", "Help me draft "),
        textPill(Search, "Research a topic", "Research and summarise "),
        textPill(HelpCircle, "Explain a concept", "Explain "),
    ],
};

// The single source of truth for which 4 pills a given agent shows on its
// welcome screen. Exported (not just used internally) so resolvePills.test.ts
// can exercise every branch directly without mounting the component.
export function resolvePills(agent: Agent | null): Pill[] {
    const slug = agent?.persona?.slug;
    if (slug === DIRECTOR_PERSONA_SLUG) return DIRECTOR_PROMPTS;
    if (slug === PM_PERSONA_SLUG) return PM_PROMPTS;

    const personaPrompts = agent?.persona?.suggestedPrompts;
    if (personaPrompts && personaPrompts.length >= 2) {
        return personaPrompts.slice(0, 4).map(p => textPill(getPillIcon(p.icon), p.label, p.promptText));
    }

    const typePills = agent?.type ? AGENT_TYPE_PROMPTS[agent.type] : undefined;
    if (typePills) return typePills;

    return GENERAL_PROMPTS;
}

interface WelcomeViewProps {
    agent: Agent | null;
    firstName: string;
    onSelectPill: (pill: PillType) => void;
    onSend: (text: string) => void;
    children: React.ReactNode;
    /** Live chat-stream state — 'waving' for this greet screen (page.tsx
     * computes it that way for a new/empty conversation). Same opt-in
     * mechanism as MessageItem's avatar: no motion unless explicitly passed. */
    avatarLiveState?: PersonaAnimationState;
}

export function WelcomeView({ agent, firstName, onSelectPill, onSend, children, avatarLiveState }: WelcomeViewProps) {
    const agentName = agent?.name ?? 'your assistant';
    const isPm = agent?.persona?.slug === PM_PERSONA_SLUG;
    const isDirector = agent?.persona?.slug === DIRECTOR_PERSONA_SLUG;
    const tagline = agent?.description
        ?? agent?.persona?.tagline
        ?? (isPm ? 'I can help you plan, design, and ship.'
            : isDirector ? 'I generate and edit images from a description.'
            : 'How can I help you today?');

    const pills = resolvePills(agent);

    return (
        <div className="flex flex-col h-full">
            <div className="flex-1 flex flex-col items-center justify-center px-8 py-12 text-center">
                <div className="mb-6">
                    <AgentOrb size={96} state="idle" avatarUrl={agent?.avatarUrl} persona={agent?.persona} liveState={avatarLiveState} isDefault={agent?.isDefault} />
                </div>

                <h2 className="text-2xl font-bold tracking-tight mb-1">
                    Hi {firstName}! I&apos;m {agentName}.
                </h2>
                <p className="text-muted-foreground text-sm mb-8">{tagline}</p>

                <div className="flex flex-wrap gap-3 justify-center max-w-md">
                    {pills.map(({ icon: Icon, label, onClick }) => (
                        <Button key={label} variant="outline"
                            className="gap-2 rounded-full px-5 py-2 h-auto text-sm font-medium bg-secondary/50 border-border/60 hover:bg-secondary hover:border-border transition-colors"
                            onClick={() => onClick({ onSelectPill, onSend })}
                        >
                            <Icon className="h-4 w-4 text-muted-foreground" /> {label}
                        </Button>
                    ))}
                </div>
            </div>

            <div className="shrink-0 pt-2 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
                {children}
            </div>
        </div>
    );
}
