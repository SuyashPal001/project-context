"use client";

import { useMemo, useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { PersonaCard } from "@/components/platform/personas/PersonaCard";
import { PersonaDetailModal } from "@/components/platform/personas/PersonaDetailModal";
import { hirePersona, firePersonaAgent, findAgentForPersona } from "@/components/platform/personas/actions";
import type { PersonaSummary, PersonasResponse } from "@/components/platform/personas/types";
import type { AgentsResponse } from "@/components/platform/agents/types";

type MarketplaceTab = "explore" | "mine";

export default function MarketplacePage() {
    const router = useRouter();
    const params = useParams();
    const tenantSlug = params.tenant as string;
    const queryClient = useQueryClient();

    const [tab, setTab] = useState<MarketplaceTab>("explore");
    const [category, setCategory] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [selectedPersona, setSelectedPersona] = useState<PersonaSummary | null>(null);

    const { data: personasData, isLoading: personasLoading } = useQuery<PersonasResponse>({
        queryKey: ["personas"],
        queryFn: () => api.get<PersonasResponse>("/api/v1/agents/personas"),
    });
    const { data: agentsData } = useQuery<AgentsResponse>({
        queryKey: ["agents"],
        queryFn: () => api.get<AgentsResponse>("/api/v1/agents"),
    });

    const personas = personasData?.personas ?? [];
    const agents = agentsData?.data ?? [];

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

    const minePersonas = personas.filter((persona) => hiredAgentFor(persona.id));

    const visiblePersonas = tab === "explore" ? explorePersonas : minePersonas;
    const selectedAgent = selectedPersona ? hiredAgentFor(selectedPersona.id) : undefined;

    const handleHire = async (personaId: string) => {
        const persona = personas.find((p) => p.id === personaId);
        if (!persona) return;
        try {
            await hirePersona(persona);
            queryClient.invalidateQueries({ queryKey: ["agents"] });
            toast.success(`${persona.name} hired.`);
            setSelectedPersona(null);
        } catch {
            toast.error("Failed to hire employee.");
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

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-3xl font-bold tracking-tight text-foreground">Marketplace</h1>
                <p className="text-muted-foreground mt-2">Browse and hire AI employees for your team</p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex gap-1 rounded-full bg-muted p-1">
                    {(["explore", "mine"] as const).map((t) => (
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
                <div className="relative w-full max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        placeholder="Search employees..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="pl-9"
                    />
                </div>
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

            {personasLoading ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {Array.from({ length: 4 }).map((_, i) => (
                        <Skeleton key={i} className="h-[280px] w-full rounded-xl" />
                    ))}
                </div>
            ) : visiblePersonas.length > 0 ? (
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                    {visiblePersonas.map((persona) => (
                        <PersonaCard
                            key={persona.id}
                            persona={persona}
                            isHired={Boolean(hiredAgentFor(persona.id))}
                            onClick={() => setSelectedPersona(persona)}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex h-[300px] shrink-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20">
                    <p className="text-sm text-muted-foreground">
                        {tab === "mine" ? "You haven't hired anyone yet." : "No employees match your search."}
                    </p>
                </div>
            )}

            <PersonaDetailModal
                persona={selectedPersona}
                open={selectedPersona !== null}
                onOpenChange={(open) => !open && setSelectedPersona(null)}
                isHired={Boolean(selectedAgent)}
                onHire={handleHire}
                onFire={handleFire}
                onAssign={handleAssign}
            />
        </div>
    );
}
