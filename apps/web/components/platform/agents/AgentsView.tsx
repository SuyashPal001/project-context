"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PersonaCard } from "@/components/platform/personas/PersonaCard";
import { PersonaDetailModal } from "@/components/platform/personas/PersonaDetailModal";
import { hirePersona, firePersonaAgent, findAgentForPersona } from "@/components/platform/personas/actions";
import type { PersonaSummary, PersonasResponse } from "@/components/platform/personas/types";
import { CreateAgentDialog } from "./CreateAgentDialog";
import { AgentCard } from "./AgentCard";
import type { AgentsResponse } from "./types";
import { TeamCard, TeamCardSkeleton } from "@/components/platform/teams/TeamCard";
import { EmployeeCardSkeleton } from "@/components/platform/shared/EmployeeCard";
import { TeamDetailModal } from "@/components/platform/teams/TeamDetailModal";
import { CreateTeamDialog } from "@/components/platform/teams/CreateTeamDialog";
import {
    createTeam, getTeam, renameTeam, deleteTeam, addTeamMember, removeTeamMember,
} from "@/components/platform/teams/actions";
import type { TeamDetail, TeamsResponse } from "@/components/platform/teams/types";

type AgentsTab = "mine" | "explore";
type MineSubTab = "employees" | "teams";

export function AgentsView() {
    const router = useRouter();
    const params = useParams();
    const searchParams = useSearchParams();
    const tenantSlug = params.tenant as string;
    const queryClient = useQueryClient();
    const { role } = useTenant();
    const isPlatformAdmin = role === "platform_admin";

    const [tab, setTab] = useState<AgentsTab>(searchParams.get("tab") === "explore" ? "explore" : "mine");
    const [mineSubTab, setMineSubTab] = useState<MineSubTab>("employees");
    const [category, setCategory] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [selectedPersona, setSelectedPersona] = useState<PersonaSummary | null>(null);
    const [selectedTeamId, setSelectedTeamId] = useState<string | null>(null);
    const [createTeamOpen, setCreateTeamOpen] = useState(false);

    const { data: personasData, isLoading: personasLoading } = useQuery<PersonasResponse>({
        queryKey: ["personas"],
        queryFn: () => api.get<PersonasResponse>("/api/v1/agents/personas"),
        enabled: tab === "explore",
    });
    const { data: agentsData, isLoading: agentsLoading, isError: agentsIsError, error: agentsError } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });
    const { data: teamsData, isLoading: teamsLoading } = useQuery<TeamsResponse>({
        queryKey: ["teams"],
        queryFn: () => api.get<TeamsResponse>("/api/v1/teams"),
        enabled: tab === "mine" && mineSubTab === "teams",
    });

    const personas = personasData?.personas ?? [];
    const agents = agentsData?.data ?? [];
    const teams = teamsData?.data ?? [];

    const teamDetailQueries = useQueries({
        queries: teams.map((team) => ({
            queryKey: ["teams", team.id],
            queryFn: () => getTeam(team.id),
            enabled: tab === "mine" && mineSubTab === "teams",
        })),
    });
    const teamDetails = teamDetailQueries.map((q) => q.data).filter((d): d is TeamDetail => Boolean(d));
    const selectedTeam = selectedTeamId ? teamDetails.find((t) => t.id === selectedTeamId) ?? null : null;

    const categories = useMemo(() => {
        const tags = new Set<string>();
        for (const persona of personas) {
            for (const tag of persona.skillTags) tags.add(tag);
        }
        return Array.from(tags).sort();
    }, [personas]);

    const hiredAgentFor = (personaId: string) => findAgentForPersona(agents, personaId);

    const explorePersonas = personas.filter((persona) => {
        if (category && !persona.skillTags.includes(category)) return false;
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return persona.name.toLowerCase().includes(q) || persona.tagline.toLowerCase().includes(q);
    });

    const hiredAgents = agents.filter((a) => a.status === "active" && !a.isInternal).filter((a) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return a.name.toLowerCase().includes(q);
    });

    const selectedAgent = selectedPersona ? hiredAgentFor(selectedPersona.id) : undefined;

    // Deep-link a persona by slug (?persona=<slug>) — the name in Explore is a
    // real shareable URL, not just an in-memory modal toggle. Runs once the
    // personas list has loaded so a link opened cold (Explore tab not yet
    // fetched) still resolves.
    useEffect(() => {
        const slug = searchParams.get("persona");
        if (!slug || personas.length === 0 || selectedPersona) return;
        const match = personas.find((p) => p.slug === slug);
        if (match) setSelectedPersona(match);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [personas, searchParams]);

    const closePersona = () => {
        setSelectedPersona(null);
        const next = new URLSearchParams(searchParams.toString());
        next.delete("persona");
        router.push(`/${tenantSlug}/dashboard/agents?${next.toString()}`, { scroll: false });
    };

    const handleHire = async (personaId: string) => {
        const persona = personas.find((p) => p.id === personaId);
        if (!persona) return;
        try {
            await hirePersona(persona);
            queryClient.invalidateQueries({ queryKey: ["agents"] });
            toast.success(`${persona.name} hired.`);
            setSelectedPersona(null);
        } catch (err) {
            if (err instanceof ApiError && err.data?.code === "AGENT_LIMIT_REACHED") {
                toast.error(`Agent limit reached (${err.data.used}/${err.data.limit} on your plan).`);
                return;
            }
            const message = err instanceof ApiError ? (err.data?.error ?? err.data?.message) : undefined;
            toast.error(message || "Failed to hire employee.");
        }
    };

    const handleFire = async (personaId: string) => {
        const agent = hiredAgentFor(personaId);
        if (!agent) return;
        try {
            await firePersonaAgent(agent.id);
            queryClient.invalidateQueries({ queryKey: ["agents"] });
            toast.success("Employee fired.");
            setSelectedPersona(null);
        } catch (err) {
            if (err instanceof ApiError && err.status === 409) {
                const { shiftsCount, teamsCount } = err.data ?? { shiftsCount: 0, teamsCount: 0 };
                if (window.confirm(`This employee is related to ${shiftsCount} Shifts, ${teamsCount} Teams. Are you sure you want to fire this employee?`)) {
                    await firePersonaAgent(agent.id, { force: true });
                    queryClient.invalidateQueries({ queryKey: ["agents"] });
                    toast.success("Employee fired.");
                    setSelectedPersona(null);
                }
            } else {
                toast.error("Failed to fire employee.");
            }
        }
    };

    const handleAssign = (personaId: string) => {
        const agent = hiredAgentFor(personaId);
        if (agent) router.push(`/${tenantSlug}/dashboard/agents/${agent.id}`);
    };

    const handleCreateTeam = async (name: string) => {
        try {
            await createTeam(name);
            queryClient.invalidateQueries({ queryKey: ["teams"] });
            toast.success(`${name} created.`);
            setCreateTeamOpen(false);
        } catch {
            toast.error("Failed to create team.");
        }
    };

    const handleRenameTeam = async (teamId: string, name: string) => {
        try {
            await renameTeam(teamId, name);
            queryClient.invalidateQueries({ queryKey: ["teams"] });
        } catch {
            toast.error("Failed to rename team.");
        }
    };

    const handleDeleteTeam = async (teamId: string) => {
        if (!window.confirm("Delete this team? This cannot be undone.")) return;
        try {
            await deleteTeam(teamId);
            queryClient.invalidateQueries({ queryKey: ["teams"] });
            setSelectedTeamId(null);
            toast.success("Team deleted.");
        } catch {
            toast.error("Failed to delete team.");
        }
    };

    const handleAddMember = async (teamId: string, agentId: string) => {
        try {
            await addTeamMember(teamId, agentId);
            queryClient.invalidateQueries({ queryKey: ["teams", teamId] });
        } catch {
            toast.error("Failed to add member.");
        }
    };

    const handleRemoveMember = async (teamId: string, agentId: string) => {
        try {
            await removeTeamMember(teamId, agentId);
            queryClient.invalidateQueries({ queryKey: ["teams", teamId] });
        } catch {
            toast.error("Failed to remove member.");
        }
    };

    return (
        <div className="space-y-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Employees</h1>
                    <p className="text-muted-foreground mt-2">Browse and hire AI employees for your team</p>
                </div>
                <div className="flex gap-2">
                    {isPlatformAdmin && (
                        <CreateAgentDialog>
                            <Button variant="outline">Create Custom</Button>
                        </CreateAgentDialog>
                    )}
                    {tab !== "explore" && (
                        <Button onClick={() => setTab("explore")}>
                            <Plus className="mr-2 h-4 w-4" />
                            Add Employee
                        </Button>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex gap-1 rounded-full bg-muted p-1">
                    {(["mine", "explore"] as const).map((t) => (
                        <button
                            key={t}
                            onClick={() => setTab(t)}
                            className={cn(
                                "rounded-full px-4 py-1.5 text-sm font-medium capitalize transition-colors",
                                tab === t ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
                            )}
                        >
                            {t}
                        </button>
                    ))}
                </div>
                {!(tab === "mine" && mineSubTab === "teams") && (
                    <div className="relative w-full max-w-xs">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                        <Input
                            placeholder="Search employees..."
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            className="pl-9 focus-visible:border-foreground/30 focus-visible:ring-foreground/10"
                        />
                    </div>
                )}
            </div>

            {tab === "explore" && categories.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant={category === null ? "default" : "outline"}
                        size="sm"
                        className="rounded-full"
                        onClick={() => setCategory(null)}
                    >
                        All
                    </Button>
                    {categories.map((tag) => (
                        <Button
                            key={tag}
                            variant={category === tag ? "default" : "outline"}
                            size="sm"
                            className="rounded-full"
                            onClick={() => setCategory(tag)}
                        >
                            {tag}
                        </Button>
                    ))}
                </div>
            )}

            {tab === "mine" && mineSubTab === "teams" ? (
                teamsLoading ? (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <TeamCardSkeleton key={i} />
                        ))}
                    </div>
                ) : (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                        {teams.map((team) => (
                            <TeamCard
                                key={team.id}
                                team={team}
                                members={agents.filter((a) =>
                                    (teamDetails.find((d) => d.id === team.id)?.memberAgentIds ?? []).includes(a.id)
                                )}
                                onClick={() => setSelectedTeamId(team.id)}
                            />
                        ))}
                        <button
                            onClick={() => setCreateTeamOpen(true)}
                            className="flex h-full min-h-[140px] items-center justify-center rounded-xl border border-dashed border-border text-sm font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
                        >
                            + Create team
                        </button>
                    </div>
                )
            ) : tab === "mine" ? (
                agentsIsError ? (
                    <Alert variant="destructive">
                        <AlertCircle className="h-4 w-4" />
                        <AlertTitle>Error</AlertTitle>
                        <AlertDescription>
                            {agentsError instanceof Error ? agentsError.message : "Failed to load agents. Please try again later."}
                        </AlertDescription>
                    </Alert>
                ) : agentsLoading ? (
                    <div className="grid gap-4 md:grid-cols-2">
                        {Array.from({ length: 4 }).map((_, i) => (
                            <EmployeeCardSkeleton key={i} />
                        ))}
                    </div>
                ) : hiredAgents.length > 0 ? (
                    <div className="grid gap-4 md:grid-cols-2">
                        {hiredAgents.map((agent) => (
                            <AgentCard key={agent.id} agent={agent} />
                        ))}
                    </div>
                ) : (
                    <div className="flex h-[300px] shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                        <div className="mx-auto flex max-w-[420px] flex-col items-center justify-center text-center">
                            <p className="text-sm text-muted-foreground mb-4">
                                {search ? "No employees match your search." : "You haven't hired anyone yet."}
                            </p>
                            {!search && (
                                <Button onClick={() => setTab("explore")}>
                                    <Plus className="mr-2 h-4 w-4" />
                                    Add Employee
                                </Button>
                            )}
                        </div>
                    </div>
                )
            ) : personasLoading ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <EmployeeCardSkeleton key={i} withOutcomes />
                    ))}
                </div>
            ) : explorePersonas.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {explorePersonas.map((persona) => (
                        <PersonaCard
                            key={persona.id}
                            persona={persona}
                            isHired={Boolean(hiredAgentFor(persona.id))}
                            href={`/${tenantSlug}/dashboard/agents?tab=explore&persona=${persona.slug}`}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex h-[300px] shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                    <p className="text-sm text-muted-foreground">No employees match your search.</p>
                </div>
            )}

            <PersonaDetailModal
                persona={selectedPersona}
                open={selectedPersona !== null}
                onOpenChange={(open) => !open && closePersona()}
                isHired={Boolean(selectedAgent)}
                onHire={handleHire}
                onFire={handleFire}
                onAssign={handleAssign}
            />

            <TeamDetailModal
                team={selectedTeam}
                agents={agents}
                open={selectedTeamId !== null}
                onOpenChange={(open) => !open && setSelectedTeamId(null)}
                onRename={handleRenameTeam}
                onDelete={handleDeleteTeam}
                onAddMember={handleAddMember}
                onRemoveMember={handleRemoveMember}
            />

            <CreateTeamDialog
                open={createTeamOpen}
                onOpenChange={setCreateTeamOpen}
                onCreate={handleCreateTeam}
            />
        </div>
    );
}
