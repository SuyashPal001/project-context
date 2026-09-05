"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useTenant } from "@/app/[tenant]/tenant-provider";
import { PermissionGate } from "@/components/platform/PermissionGate";
import { PermissionPicker } from "@/components/platform/roles/PermissionPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, ArrowLeft, Shield } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

interface RoleDetail {
    id: string;
    name: string;
    description: string | null;
    tenantId: string | null;
    isDefault: boolean;
    permissions: { id: string; resource: string; action: string }[];
}

export default function EditRolePage() {
    const params = useParams();
    const router = useRouter();
    const { tenantId } = useTenant();
    const queryClient = useQueryClient();
    const roleId = params.roleId as string;

    const { data, isLoading, isError } = useQuery<{ data: RoleDetail }>({
        queryKey: ["role", roleId],
        queryFn: () => api.get(`/api/v1/roles/${roleId}`),
        enabled: !!roleId,
    });

    const role = data?.data;
    const isSystem = !role?.tenantId;

    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [selectedPerms, setSelectedPerms] = useState<string[]>([]);

    useEffect(() => {
        if (role) {
            setName(role.name);
            setDescription(role.description ?? "");
            setSelectedPerms(role.permissions.map(p => p.id));
        }
    }, [role]);

    const updateMeta = useMutation({
        mutationFn: () => api.patch(`/api/v1/roles/${roleId}`, { name, description }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ["role", roleId] }),
    });

    const updatePerms = useMutation({
        mutationFn: async () => {
            const original = role?.permissions.map(p => p.id) ?? [];
            const toAdd = selectedPerms.filter(id => !original.includes(id));
            const toRemove = original.filter(id => !selectedPerms.includes(id));
            await Promise.all([
                toAdd.length > 0 ? api.post(`/api/v1/roles/${roleId}/permissions`, { permissionIds: toAdd }) : null,
                ...toRemove.map(id => api.del(`/api/v1/roles/${roleId}/permissions/${id}`)),
            ].filter(Boolean));
        },
    });

    const handleSave = async () => {
        try {
            await Promise.all([updateMeta.mutateAsync(), updatePerms.mutateAsync()]);
            toast.success("Role updated");
            queryClient.invalidateQueries({ queryKey: ["roles"] });
            router.push(`/${tenantId}/dashboard/settings/roles`);
        } catch {
            toast.error("Failed to save role");
        }
    };

    if (isLoading) return <div className="space-y-4">{[1,2,3].map(i => <Skeleton key={i} className="h-12 w-full"/>)}</div>;
    if (isError) return <Alert variant="destructive"><AlertCircle className="h-4 w-4"/><AlertTitle>Error</AlertTitle><AlertDescription>Failed to load role.</AlertDescription></Alert>;

    return (
        <PermissionGate resource="roles" action="update">
            <div className="space-y-6 pb-10">
                <div className="flex items-center gap-3">
                    <Link href={`/${tenantId}/dashboard/settings/roles`}>
                        <Button variant="ghost" size="icon"><ArrowLeft className="h-4 w-4"/></Button>
                    </Link>
                    <div className="flex items-center gap-2">
                        <Shield className="h-5 w-5 text-primary"/>
                        <h1 className="text-2xl font-bold">{role?.name}</h1>
                        {isSystem && <span className="text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded">System role — read-only</span>}
                    </div>
                </div>

                <div className="space-y-5 max-w-2xl">
                    {isSystem ? (
                        <>
                            <div className="space-y-1">
                                <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Name</Label>
                                <p className="text-lg font-extrabold capitalize">{name}</p>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Description</Label>
                                <p className="text-base font-medium text-foreground/80">{description || "—"}</p>
                            </div>
                        </>
                    ) : (
                        <>
                            <div className="space-y-1.5">
                                <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Name</Label>
                                <Input value={name} onChange={e => setName(e.target.value)}/>
                            </div>
                            <div className="space-y-1.5">
                                <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Description</Label>
                                <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}/>
                            </div>
                        </>
                    )}
                </div>

                <div className="space-y-3 pt-2">
                    <h2 className="font-bold text-sm text-muted-foreground uppercase tracking-wider">Permissions</h2>
                    <PermissionPicker selected={selectedPerms} onChange={setSelectedPerms} disabled={isSystem}/>
                </div>

                {!isSystem && (
                    <div className="flex justify-end gap-3 max-w-2xl">
                        <Link href={`/${tenantId}/dashboard/settings/roles`}>
                            <Button variant="outline">Cancel</Button>
                        </Link>
                        <Button onClick={handleSave} disabled={updateMeta.isPending || updatePerms.isPending}>
                            {(updateMeta.isPending || updatePerms.isPending) ? "Saving..." : "Save changes"}
                        </Button>
                    </div>
                )}
            </div>
        </PermissionGate>
    );
}
