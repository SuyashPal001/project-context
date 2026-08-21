"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { canDelete, can } from "@/lib/permissions";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Shield, Users, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardDescription,
    CardHeader,
    CardTitle,
    CardContent,
} from "@/components/ui/card";
import { DeleteRoleAction } from "./DeleteRoleAction";
import Link from "next/link";

export interface Role {
    id: string;
    name: string;
    description?: string;
    isDefault: boolean;
    tenantId: string | null;
    memberCount: number;
}

interface RolesResponse {
    roles: Role[];
}

export function RolesList() {
    const { tenantId, permissions = [] } = useTenant();

    const { data, isLoading, isError, error } = useQuery<RolesResponse>({
        queryKey: ["roles", tenantId],
        queryFn: () => api.get<RolesResponse>("/api/v1/roles"),
        enabled: !!tenantId,
        staleTime: 0,
    });

    const canDeleteRoles = canDelete(permissions, "roles");
    const canUpdateRoles = can(permissions, "roles", "update");

    if (isLoading) {
        return (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-[140px] w-full rounded-xl" />
                ))}
            </div>
        );
    }

    if (isError) {
        return (
            <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Error</AlertTitle>
                <AlertDescription>
                    {error instanceof Error ? error.message : "Failed to load roles."}
                </AlertDescription>
            </Alert>
        );
    }

    const roles = data?.roles || [];

    if (roles.length === 0) {
        return (
            <div className="text-center py-10 bg-muted/20 rounded-md border border-dashed border-border">
                <p className="text-muted-foreground">No roles found.</p>
            </div>
        );
    }

    return (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {roles.map((role) => (
                <Card key={role.id} className="bg-card/50 border-border hover:border-border/80 transition-colors">
                    <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                        <div className="flex items-center gap-2">
                            <Shield className="w-4 h-4 text-primary" />
                            <CardTitle className="text-lg font-bold">{role.name}</CardTitle>
                            {role.isDefault && (
                                <Badge variant="secondary" className="text-[10px] uppercase font-bold tracking-widest px-1.5 py-0 h-4">
                                    System
                                </Badge>
                            )}
                        </div>
                        <div className="flex items-center gap-1">
                            {canUpdateRoles && (
                                <Link href={`/${tenantId}/dashboard/settings/roles/${role.id}`}>
                                    <button className="h-8 w-8 flex items-center justify-center rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground">
                                        <Settings className="h-4 w-4"/>
                                    </button>
                                </Link>
                            )}
                            {!role.isDefault && !!role.tenantId && canDeleteRoles && (
                                <DeleteRoleAction roleId={role.id} roleName={role.name} />
                            )}
                        </div>
                    </CardHeader>
                    <CardContent>
                        <CardDescription className="text-sm font-medium text-foreground/80 mb-4 line-clamp-2 min-h-[40px]">
                            {role.description || "No description provided."}
                        </CardDescription>
                        <div className="flex items-center text-xs text-muted-foreground gap-1">
                            <Users className="w-3 h-3" />
                            <span>{role.memberCount} members assigned</span>
                        </div>
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
