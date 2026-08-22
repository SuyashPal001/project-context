"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import {
    Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { PersonaAvatar } from "@/components/platform/personas/PersonaAvatar";
import type { Agent } from "@/components/platform/agents/types";
import type { TeamDetail } from "./types";

interface TeamDetailModalProps {
    team: TeamDetail | null;
    agents: Agent[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: (teamId: string, name: string) => void;
    onDelete: (teamId: string) => void;
    onAddMember: (teamId: string, agentId: string) => void;
    onRemoveMember: (teamId: string, agentId: string) => void;
}

export function TeamDetailModal({
    team, agents, open, onOpenChange, onRename, onDelete, onAddMember, onRemoveMember,
}: TeamDetailModalProps) {
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState("");
    const [addingMember, setAddingMember] = useState(false);
    const [memberSearch, setMemberSearch] = useState("");

    const members = useMemo(
        () => (team ? agents.filter((a) => team.memberAgentIds.includes(a.id)) : []),
        [team, agents]
    );

    const available = useMemo(() => {
        if (!team) return [];
        const q = memberSearch.trim().toLowerCase();
        return agents.filter((a) => {
            if (team.memberAgentIds.includes(a.id)) return false;
            if (!q) return true;
            return a.name.toLowerCase().includes(q);
        });
    }, [team, agents, memberSearch]);

    if (!team) return null;

    const startRename = () => {
        setNameDraft(team.name);
        setEditingName(true);
    };

    const commitRename = () => {
        const trimmed = nameDraft.trim();
        if (trimmed && trimmed !== team.name) onRename(team.id, trimmed);
        setEditingName(false);
    };

    const handleClose = (nextOpen: boolean) => {
        setEditingName(false);
        setAddingMember(false);
        setMemberSearch("");
        onOpenChange(nextOpen);
    };

    return (
        <Dialog open={open} onOpenChange={handleClose}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    {editingName ? (
                        <Input
                            value={nameDraft}
                            onChange={(e) => setNameDraft(e.target.value)}
                            onBlur={commitRename}
                            onKeyDown={(e) => e.key === "Enter" && commitRename()}
                            autoFocus
                            className="text-xl font-semibold"
                        />
                    ) : (
                        <DialogTitle className="cursor-pointer text-xl" onClick={startRename}>
                            {team.name}
                        </DialogTitle>
                    )}
                </DialogHeader>

                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Members ({members.length})
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => setAddingMember((v) => !v)}>
                            {addingMember ? "Done" : "+ Add member"}
                        </Button>
                    </div>

                    {members.length > 0 ? (
                        <div className="space-y-1.5">
                            {members.map((agent) => (
                                <div key={agent.id} className="flex items-center gap-2 rounded-md border border-border/50 px-2 py-1.5">
                                    <PersonaAvatar persona={agent.persona} avatarUrl={agent.avatarUrl} size={28} className="rounded-full" />
                                    <span className="flex-1 text-sm font-medium text-foreground">{agent.name}</span>
                                    <button
                                        type="button"
                                        onClick={() => onRemoveMember(team.id, agent.id)}
                                        className="text-muted-foreground hover:text-foreground"
                                        aria-label={`Remove ${agent.name}`}
                                    >
                                        <X className="h-4 w-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">No members yet.</p>
                    )}

                    {addingMember && (
                        <div className="space-y-2 rounded-md border border-border/50 p-2">
                            <Input
                                placeholder="Search employees..."
                                value={memberSearch}
                                onChange={(e) => setMemberSearch(e.target.value)}
                            />
                            <div className="max-h-48 space-y-1 overflow-y-auto">
                                {available.length > 0 ? (
                                    available.map((agent) => (
                                        <label
                                            key={agent.id}
                                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                                        >
                                            <Checkbox
                                                checked={false}
                                                onCheckedChange={() => onAddMember(team.id, agent.id)}
                                            />
                                            <PersonaAvatar persona={agent.persona} avatarUrl={agent.avatarUrl} size={24} className="rounded-full" />
                                            <span className="text-sm text-foreground">{agent.name}</span>
                                        </label>
                                    ))
                                ) : (
                                    <p className="px-2 py-1.5 text-sm text-muted-foreground">No matching employees.</p>
                                )}
                            </div>
                        </div>
                    )}
                </div>

                <DialogFooter>
                    <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => onDelete(team.id)}>
                        Delete team
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
