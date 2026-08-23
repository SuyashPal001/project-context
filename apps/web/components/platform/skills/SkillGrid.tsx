"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SkillCard } from "./SkillCard";
import { SkillDetailPanel } from "./SkillDetailPanel";
import type { Skill } from "./types";

interface SkillGridProps {
    skills: Skill[];
    tenantId: string;
    onInstall: (skillId: string) => void;
    onUninstall: (skillId: string) => void;
    onPublish: (skillId: string) => void;
}

export function SkillGrid({ skills, tenantId, onInstall, onUninstall, onPublish }: SkillGridProps) {
    // Track the id, not the Skill object — the list keeps refetching while an
    // import is pending, so deriving `active` from the current `skills` array
    // keeps the open panel in sync instead of freezing on a stale snapshot.
    const [activeId, setActiveId] = useState<string | null>(null);
    const active = skills.find((s) => s.id === activeId) ?? null;
    const uid = useId();

    useEffect(() => {
        function onKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") setActiveId(null);
        }
        document.body.style.overflow = active ? "hidden" : "auto";
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [active]);

    return (
        <>
            <AnimatePresence>
                {active && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-40 bg-black/40"
                    />
                )}
            </AnimatePresence>

            <AnimatePresence>
                {active && (
                    <SkillDetailPanel
                        skill={active}
                        layoutId={`skill-card-${active.id}-${uid}`}
                        titleLayoutId={`skill-title-${active.id}-${uid}`}
                        descriptionLayoutId={`skill-description-${active.id}-${uid}`}
                        isOwner={active.ownerTenantId === tenantId}
                        onClose={() => setActiveId(null)}
                        onInstall={() => onInstall(active.id)}
                        onUninstall={() => onUninstall(active.id)}
                        onPublish={() => onPublish(active.id)}
                    />
                )}
            </AnimatePresence>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                {skills.map((skill) => (
                    <SkillCard
                        key={skill.id}
                        skill={skill}
                        layoutId={`skill-card-${skill.id}-${uid}`}
                        titleLayoutId={`skill-title-${skill.id}-${uid}`}
                        descriptionLayoutId={`skill-description-${skill.id}-${uid}`}
                        isOwner={skill.ownerTenantId === tenantId}
                        onExpand={() => setActiveId(skill.id)}
                        onInstall={() => onInstall(skill.id)}
                        onUninstall={() => onUninstall(skill.id)}
                        onPublish={() => onPublish(skill.id)}
                    />
                ))}
            </div>
        </>
    );
}
