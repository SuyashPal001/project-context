"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Check, LayoutTemplate, Music, Package, UserRound, Zap } from "lucide-react";
import { OlmoMark } from "@/components/platform/OlmoMark";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import { getAgentTypeIcon } from "@/components/platform/agents/agentTypeIcon";
import { cn } from "@/lib/utils";
import type { Agent } from "@/components/platform/agents/types";
import { CreativeLibrary } from "./CreativeLibrary";
import {
    fieldForTab,
    type CreativeBrief,
    type CreativeLibraryTab,
    type CreativeSelection,
    type ProductRecordSelection,
} from "./creative-library/creativeBriefModel";

// Category shortcuts under the composer — Templates (proven ad-structure
// starting points), Avatars, Products, Audio. No "Browse" tab: research on
// comparable ad-creation tools (Creatify, Arcads, AdCreative.ai) turned up no
// evidence of a generic "browse everything" tab at any of them, only these
// four named, revenue-driving categories.
const LIBRARY_TABS = [
    { id: 'templates', label: 'Templates', icon: LayoutTemplate },
    { id: 'avatars', label: 'Avatars', icon: UserRound },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'audio', label: 'Audio', icon: Music },
] as const;

interface CreativeEmptyStateProps {
    /** Null or a built-in agent renders the Olmo mark; any other agent shows its own avatar and name. */
    agent: Agent | null;
    firstName: string;
    planName: string;
    upgradeHref: string | null;
    brief: CreativeBrief;
    activeTab: CreativeLibraryTab | null;
    onTabChange: (update: (current: CreativeLibraryTab | null) => CreativeLibraryTab | null) => void;
    onSelect: (selection: CreativeSelection) => void;
    /** Called when a product's AI naming finishes, even after the Products tab closed. */
    onProductNamed?: (product: ProductRecordSelection) => void;
    /** The composer — differs between the no-conversation screen and an empty existing chat. */
    children: ReactNode;
}

/** The clean "what are we creating today?" screen. Shared by the
 *  no-conversation composer and an existing-but-empty chat, so both show the
 *  same header, greeting and creative-library shortcuts instead of an older
 *  generic welcome with pills that don't match what the agent does. */
export function CreativeEmptyState({ agent, firstName, planName, upgradeHref, brief, activeTab, onTabChange, onSelect, onProductNamed, children }: CreativeEmptyStateProps) {
    return (
        <div className="w-full max-w-2xl mx-auto flex flex-col items-center py-8">
            <div className="flex flex-col items-center gap-2 mb-8">
                {!agent || agent.origin === 'built_in' ? (
                    <div className="flex items-center gap-1.5 opacity-80">
                        <OlmoMark height={18} />
                        <span className="text-sm font-semibold tracking-tight">Olmo Creative Agent</span>
                    </div>
                ) : (
                    <div className="flex items-center gap-1.5 opacity-80">
                        <PersonaAvatar
                            persona={agent.persona}
                            avatarUrl={agent.avatarUrl}
                            size={18}
                            className="rounded-full h-[18px] w-[18px] shrink-0"
                            iconClassName="text-foreground/50"
                            icon={getAgentTypeIcon(agent.type)}
                        />
                        <span className="text-sm font-semibold tracking-tight">{agent.name}</span>
                    </div>
                )}
                <div className="flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs font-medium">
                    <span className="text-muted-foreground">{planName} plan</span>
                    {upgradeHref && (
                        <>
                            <span className="text-border">|</span>
                            <Link href={upgradeHref} className="flex items-center gap-1 font-semibold text-foreground hover:opacity-80 transition-opacity">
                                <Zap className="h-3 w-3 fill-foreground shrink-0" />
                                Upgrade
                            </Link>
                        </>
                    )}
                </div>
            </div>
            <h1 className="text-3xl font-bold tracking-tight mb-8">{firstName ? `Hi ${firstName}, what are we creating today?` : "What are we creating today?"}</h1>
            <div className="w-full">{children}</div>
            <div className="-mt-2 flex flex-wrap items-center justify-center gap-2">
                {LIBRARY_TABS.map((tab) => (
                    <button
                        key={tab.id}
                        type="button"
                        onClick={() => onTabChange((cur) => (cur === tab.id ? null : tab.id))}
                        className={cn(
                            "h-9 px-4 flex items-center gap-2 rounded-full border text-sm font-medium transition-colors",
                            activeTab === tab.id
                                ? "bg-foreground text-background border-foreground"
                                : "bg-card border-border text-muted-foreground hover:text-foreground"
                        )}
                    >
                        {brief[fieldForTab(tab.id)] ? <Check className="h-4 w-4" /> : <tab.icon className="h-4 w-4" />}
                        {tab.label}
                    </button>
                ))}
            </div>
            {activeTab && <CreativeLibrary tab={activeTab} brief={brief} onSelect={onSelect} onProductNamed={onProductNamed} />}
        </div>
    );
}
