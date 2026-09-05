'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Search, AtSign } from "lucide-react";
import { SkillIcon } from "@/components/platform/skills/SkillIcon";
import { listSkills } from "@/components/platform/skills/actions";
import type { Skill } from "@/components/platform/skills/types";
import type { PaletteHandle } from "./paletteHandle";

export type { PaletteHandle };

interface SlashPaletteProps {
    query: string;
    onSelect: (skill: Skill) => void;
    onClose: () => void;
    /** Switches the composer to the "@" palette from the empty-state hint. */
    onSwitchToMention: () => void;
}

// Typing "/" opens this to attach an installed skill. Skills only — employees
// live behind "@" (MentionPalette) and files behind "#" (HashFilePalette). The
// three namespaces are deliberately disjoint: "/" is the verb key everywhere
// else users come from (Slack, Notion, Linear), "@" is the entity key, and a
// key that returns two kinds of thing teaches neither. This palette used to
// return agents under a "Skills and AI employees" heading, which made employees
// reachable from both "/" and "@" while skills were reachable from neither.
export const SlashPalette = forwardRef<PaletteHandle, SlashPaletteProps>(function SlashPalette(
    { query, onSelect, onClose, onSwitchToMention },
    ref,
) {
    // "installed" — not "mine". `mine` filters on ownerTenantId, so a skill
    // installed from the Public or Official tab never appears there. Same query
    // key as AttachSkillPicker so the two share one cache.
    const { data, isLoading } = useQuery<Skill[]>({
        queryKey: ["skills", "installed"],
        queryFn: () => listSkills("installed"),
    });

    const installed = (data ?? []).filter(s => s.installed);
    const filtered = query
        ? installed.filter(s =>
            s.name.toLowerCase().includes(query.toLowerCase())
            || s.slug.toLowerCase().includes(query.toLowerCase()))
        : installed;

    const [activeIndex, setActiveIndex] = useState(0);

    // Query changes reshuffle `filtered`, so a stale index would highlight the
    // wrong row (or point past the end) as the user keeps typing.
    useEffect(() => { setActiveIndex(0); }, [query]);

    useImperativeHandle(ref, () => ({
        moveActive: (delta: number) => {
            if (filtered.length === 0) return;
            setActiveIndex(i => (i + delta + filtered.length) % filtered.length);
        },
        selectActive: () => {
            const skill = filtered[activeIndex];
            if (!skill) return false;
            onSelect(skill);
            onClose();
            return true;
        },
    }), [filtered, activeIndex, onSelect, onClose]);

    return (
        <div className="absolute bottom-full left-0 right-0 mb-1.5 rounded-2xl border border-border/50 bg-popover shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28),0_8px_24px_-8px_rgba(0,0,0,0.16)] dark:shadow-[0_24px_60px_-15px_rgba(0,0,0,0.65),0_10px_28px_-8px_rgba(0,0,0,0.45),inset_0_1px_0_0_rgba(255,255,255,0.05)] p-2.5 max-h-72 overflow-y-auto custom-scrollbar">
            <div className="px-2 pb-2 pt-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                Skills
            </div>
            <div className="flex items-center gap-2 px-2.5 py-2 mb-2 rounded-xl bg-muted/50 text-muted-foreground">
                <Search className="h-3.5 w-3.5 shrink-0" />
                <span className="text-xs truncate">
                    {query ? query : "Search skills"}
                </span>
            </div>
            {isLoading ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : filtered.length === 0 ? (
                <>
                    <div className="px-2 py-3 text-xs text-muted-foreground">
                        {installed.length === 0
                            ? "No installed skills yet — install one from the Skills page."
                            : `No skills match "${query}"`}
                    </div>
                    {/* Cross-hint instead of merging the two lists: a dead end on
                        "/" is what pushes people to assume employees live here. */}
                    <button
                        type="button"
                        onClick={onSwitchToMention}
                        className="w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left text-xs text-muted-foreground hover:bg-muted/60 transition-colors"
                    >
                        <AtSign className="h-3.5 w-3.5 shrink-0" />
                        <span>Looking for an AI employee? Press <kbd className="px-1 py-0.5 rounded bg-muted font-mono">@</kbd></span>
                    </button>
                </>
            ) : (
                filtered.map((skill, i) => (
                    <button
                        key={skill.id}
                        type="button"
                        onClick={() => { onSelect(skill); onClose(); }}
                        onMouseEnter={() => setActiveIndex(i)}
                        className={`w-full flex items-start gap-3 px-2 py-2.5 rounded-xl text-left transition-colors ${i === activeIndex ? 'bg-muted/60' : 'hover:bg-muted/60'}`}
                    >
                        <SkillIcon seed={skill.id} className="h-11 w-11 rounded-xl shrink-0" />
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5 pt-0.5 overflow-hidden">
                            <span className="text-sm font-medium truncate">{skill.name}</span>
                            <span className="text-xs text-muted-foreground truncate">
                                {skill.description ?? `v${skill.installedVersion ?? skill.latestVersion}`}
                            </span>
                        </div>
                    </button>
                ))
            )}
        </div>
    );
});
