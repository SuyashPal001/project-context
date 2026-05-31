"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { refreshSession } from "@/lib/auth";
import { useHyperspace } from "@/components/hyperspace-provider";
import { StarfieldCanvas } from "@/components/starfield-canvas";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface Workspace {
    tenantId: string;
    name: string;
    slug: string;
    role: string;
    isCurrent: boolean;
}

interface Props {
    workspaces: Workspace[];
    pendingTokens: { idToken: string; refreshToken: string; accessToken: string };
}

export function WorkspacePicker({ workspaces, pendingTokens }: Props) {
    const router = useRouter();
    const { startHyperspace } = useHyperspace();
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function handleSelect(ws: Workspace) {
        setIsLoading(true);
        setError(null);
        try {
            let { idToken, accessToken } = pendingTokens;
            const { refreshToken } = pendingTokens;

            if (!ws.isCurrent) {
                const refreshed = await refreshSession(refreshToken, { tenantId: ws.tenantId });
                idToken = refreshed.idToken;
                accessToken = refreshed.accessToken;
            }

            const res = await fetch('/api/auth/session', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: idToken, accessToken, refreshToken }),
            });
            if (!res.ok) throw new Error('Failed to create secure session');
            startHyperspace();
            router.push(`/${ws.slug}/dashboard`);
            router.refresh();
        } catch (err: any) {
            setError(err.message || 'Failed to select workspace.');
        } finally {
            setIsLoading(false);
        }
    }

    return (
        <div className="relative flex items-center justify-center min-h-screen bg-background overflow-hidden">
            <StarfieldCanvas speedMode="idle" />
            <div className="relative z-10 w-full max-w-md p-8 space-y-6 rounded-xl border border-border bg-card shadow-sm">
                <div className="text-center space-y-2">
                    <h1 className="text-3xl font-bold tracking-tight text-foreground">Choose a workspace</h1>
                    <p className="text-sm text-muted-foreground">You belong to multiple workspaces</p>
                </div>

                {error && (
                    <div className="p-3 text-sm font-medium text-destructive bg-destructive/10 rounded-md">{error}</div>
                )}

                <div className="space-y-3">
                    {workspaces.map((ws) => (
                        <Card
                            key={ws.tenantId}
                            className="cursor-pointer border border-border hover:border-primary transition-colors"
                            onClick={() => !isLoading && handleSelect(ws)}
                        >
                            <CardHeader className="pb-1 pt-4 px-4">
                                <CardTitle className="text-base flex items-center justify-between">
                                    <span>{ws.name}</span>
                                    {ws.isCurrent && (
                                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                                            Current
                                        </span>
                                    )}
                                </CardTitle>
                            </CardHeader>
                            <CardContent className="pb-4 px-4">
                                <p className="text-xs text-muted-foreground capitalize">{ws.role}</p>
                            </CardContent>
                        </Card>
                    ))}
                </div>

                {isLoading && <p className="text-center text-sm text-muted-foreground">Signing in...</p>}
            </div>
        </div>
    );
}
