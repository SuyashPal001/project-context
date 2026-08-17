"use client"

import * as React from "react"
import { useRouter, usePathname } from "next/navigation"
import { ChevronsUpDown, Check, Plus } from "lucide-react"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { cn } from "@/lib/utils"
import { api, ApiError } from "@/lib/api"
import { toast } from "sonner"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

export function WorkspaceSwitcherPill({ collapsed }: { collapsed?: boolean }) {
    const router = useRouter()
    const pathname = usePathname()
    const { tenantSlug } = useTenant()
    const currentSlugFromUrl = pathname?.split('/')[1] || ''

    const [isOpen, setIsOpen] = React.useState(false)
    const [isCreateModalOpen, setIsCreateModalOpen] = React.useState(false)
    const [newWorkspaceName, setNewWorkspaceName] = React.useState("")
    const [isCreating, setIsCreating] = React.useState(false)
    const [workspaces, setWorkspaces] = React.useState<any[]>([])
    const [isLoadingWorkspaces, setIsLoadingWorkspaces] = React.useState(true)

    React.useEffect(() => {
        api.get<{ tenants: any[] }>('/api/v1/auth/tenants')
            .then((data) => setWorkspaces(data.tenants || []))
            .catch(console.error)
            .finally(() => setIsLoadingWorkspaces(false))
    }, [])

    const currentWorkspace = workspaces.find(w => w.slug === currentSlugFromUrl) || workspaces.find(w => w.slug === tenantSlug) || workspaces.find(w => w.isCurrent)
    const displaySlug = tenantSlug?.toUpperCase() || 'PLATFORM'

    const handleSwitch = async (workspace: any) => {
        if (workspace.slug === currentSlugFromUrl) {
            setIsOpen(false)
            return
        }
        try {
            const res = await fetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenantId: workspace.tenantId }),
            });
            if (!res.ok) throw new Error('Failed to switch workspace');
            // Hard redirect — bypasses RSC cache, forces layout to re-run with new JWT cookie
            window.location.href = `/${workspace.slug}/dashboard`;
        } catch (error) {
            console.error('Failed to switch workspace', error)
            toast.error("Failed to switch workspace");
        }
    }

    const handleCreateWorkspace = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!newWorkspaceName.trim()) return

        setIsCreating(true)
        try {
            const res = await api.post<{ tenantId: string, slug: string }>('/api/v1/tenants', { name: newWorkspaceName })
            toast.success("Workspace created")
            await fetch('/api/auth/refresh', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tenantId: res.tenantId }),
            })
            router.push(`/${res.slug}/dashboard`)
            router.refresh()
            setIsCreateModalOpen(false)
            setNewWorkspaceName("")
            setIsOpen(false)
        } catch (error: any) {
            console.error('Failed to create workspace', error)
            let errorData = null;
            if (error instanceof ApiError) {
                errorData = error.data;
            } else if (error.response) {
                errorData = await error.response.json().catch(() => null);
            }
            if (error?.status === 403 || errorData?.code === 'FEATURE_NOT_ENTITLED') {
                toast.error("Workspace limit reached. Upgrade to create more workspaces.", {
                    action: {
                        label: "Upgrade",
                        onClick: () => router.push(`/${tenantSlug || currentSlugFromUrl}/dashboard/billing`)
                    }
                })
            } else if (errorData?.code === 'CONFLICT') {
                toast.error("You already have a workspace with this name.");
            } else {
                toast.error(errorData?.error || "Failed to create workspace. Please try again.");
            }
        } finally {
            setIsCreating(false)
        }
    }

    return (
        <>
            <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
                <DropdownMenuTrigger className={cn(
                    "flex items-center gap-2.5 rounded-lg hover:bg-accent/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring w-full",
                    collapsed ? "justify-center p-2" : "px-2.5 py-1.5"
                )}>
                    <span className="shrink-0 rounded-full bg-primary shadow-[0_0_8px_color-mix(in_oklch,var(--primary)_55%,transparent)] w-2.5 h-2.5" />
                    {!collapsed && (
                        <>
                            <span className="flex flex-col min-w-0 flex-1 text-left leading-tight">
                                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider truncate">
                                    Project Context
                                </span>
                                <span className="text-[14px] font-semibold text-foreground tracking-tight truncate">
                                    {isLoadingWorkspaces ? displaySlug : (currentWorkspace?.name || displaySlug)}
                                </span>
                            </span>
                            <ChevronsUpDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        </>
                    )}
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-[240px]" align="start" side={collapsed ? "right" : "bottom"}>
                    <DropdownMenuLabel className="text-xs text-muted-foreground uppercase tracking-wider">Switch Workspace</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {workspaces.map((workspace) => (
                        <DropdownMenuItem
                            key={workspace.tenantId}
                            className="flex flex-col items-start gap-1 cursor-pointer py-2 px-3 focus:bg-accent focus:text-accent-foreground"
                            onClick={(e) => {
                                e.preventDefault();
                                handleSwitch(workspace);
                            }}
                        >
                            <div className="flex items-center justify-between w-full">
                                <span className="font-medium text-sm truncate">{workspace.name}</span>
                                {workspace.slug === currentSlugFromUrl && (
                                    <Check className="w-4 h-4 text-primary shrink-0 ml-2" />
                                )}
                            </div>
                            <span className="text-xs text-muted-foreground opacity-70">
                                {workspace.role.replace('_', ' ')}
                            </span>
                        </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        className="flex items-center gap-2 cursor-pointer py-2 px-3 text-muted-foreground"
                        onSelect={(e) => {
                            e.preventDefault();
                            setIsOpen(false);
                            setIsCreateModalOpen(true);
                        }}
                    >
                        <Plus className="w-4 h-4" />
                        <span className="font-medium text-sm">Create Workspace</span>
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>

            <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Create Workspace</DialogTitle>
                        <DialogDescription>
                            Create a new workspace to collaborate with your team.
                        </DialogDescription>
                    </DialogHeader>
                    <form onSubmit={handleCreateWorkspace}>
                        <div className="py-4">
                            <Input
                                placeholder="Workspace Name"
                                value={newWorkspaceName}
                                onChange={(e) => setNewWorkspaceName(e.target.value)}
                                disabled={isCreating}
                                autoFocus
                            />
                        </div>
                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => setIsCreateModalOpen(false)}
                                disabled={isCreating}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={isCreating || !newWorkspaceName.trim()}>
                                {isCreating ? "Creating..." : "Create"}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    )
}
