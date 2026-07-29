"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { LogOut, User, ChevronDown, Check, Plus, Bell } from "lucide-react"
import { useTenant } from "@/app/[tenant]/tenant-provider"
import { useNotifications } from "@/lib/notifications-context"
import { signOut } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
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

function WorkspaceSwitcher({ currentPlanColor, plan, tenantSlug, workspaces, isLoading }: { currentPlanColor: string, plan: string, tenantSlug: string | undefined, workspaces: any[], isLoading: boolean }) {
    const router = useRouter()
    const pathname = usePathname()
    const currentSlugFromUrl = pathname?.split('/')[1] || ''
    const [isOpen, setIsOpen] = React.useState(false)
    const [isCreateModalOpen, setIsCreateModalOpen] = React.useState(false)
    const [newWorkspaceName, setNewWorkspaceName] = React.useState("")
    const [isCreating, setIsCreating] = React.useState(false)

    const currentWorkspace = workspaces.find(w => w.slug === currentSlugFromUrl) || workspaces.find(w => w.slug === tenantSlug) || workspaces.find(w => w.isCurrent)

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
            
            // Switch to it
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

    const displaySlug = tenantSlug?.toUpperCase() || 'PLATFORM'

    return (
        <div className="flex items-center gap-2">
            <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
                <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1.5 -ml-2 rounded-md hover:bg-accent/50 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <span className="text-sm font-semibold text-foreground tracking-tight">
                        {isLoading ? displaySlug : (currentWorkspace?.name || displaySlug)}
                    </span>
                    <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-[260px]" align="start">
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

            <button
                onClick={() => tenantSlug && router.push(`/${tenantSlug}/dashboard/billing`)}
                className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border tracking-widest transition-opacity hover:opacity-80 cursor-pointer ml-1",
                    currentPlanColor
                )}
            >
                {plan || "Free"}
            </button>
        </div>
    )
}

import { useSidebar } from "./SidebarContext"

export function Topbar() {
    const router = useRouter()
    const pathname = usePathname()
    const { tenantSlug, plan, email, name, role } = useTenant()
    const { isSidebarCollapsed } = useSidebar()
    const { unreadCount } = useNotifications()
    
    const [workspaces, setWorkspaces] = React.useState<any[]>([])
    const [isLoadingWorkspaces, setIsLoadingWorkspaces] = React.useState(true)
    const [isDropdownOpen, setIsDropdownOpen] = React.useState(false)

    // Single fetch for the whole Topbar — passed down to WorkspaceSwitcher as props
    // so it doesn't need its own duplicate call.
    React.useEffect(() => {
        api.get<{ tenants: any[] }>('/api/v1/auth/tenants')
            .then((data) => setWorkspaces(data.tenants || []))
            .catch(console.error)
            .finally(() => setIsLoadingWorkspaces(false))
    }, [])

    const currentWorkspace = workspaces.find(w => w.slug === tenantSlug) || workspaces.find(w => w.isCurrent)

    const getInitials = () => {
        if (name) return name.split(' ').map((n: string) => n[0]).join('').toUpperCase()
        if (email) return email[0].toUpperCase()
        return "US"
    }

    const getAvatarBg = () => {
        if (role === 'platform_admin') return "bg-[#ff7f50]" // Coral
        if (role === 'member') return "bg-blue-500"
        return "bg-zinc-500" // Admin/Owner default
    }

    const planColors: Record<string, string> = {
        free: "bg-muted text-muted-foreground border-border",
        starter: "bg-blue-500/10 text-blue-500 border-blue-500/20",
        business: "bg-purple-500/10 text-purple-500 border-purple-500/20",
        enterprise: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    }

    const isNotificationsActive = pathname === `/${tenantSlug}/dashboard/notifications`

    const currentPlanColor = planColors[plan?.toLowerCase()] || planColors.free
    const isStarterPlan = ['free', 'starter'].includes(plan?.toLowerCase() || '')

    return (
        <header className={cn(
            "fixed top-0 right-0 h-16 flex items-center justify-between px-8 bg-card border-b border-border z-40 transition-all duration-300",
            isSidebarCollapsed ? "left-16" : "left-60"
        )}>
            <WorkspaceSwitcher currentPlanColor={currentPlanColor} plan={plan} tenantSlug={tenantSlug} workspaces={workspaces} isLoading={isLoadingWorkspaces} />

            <div className="flex items-center gap-2">
                <Link
                    href={`/${tenantSlug}/dashboard/notifications`}
                    aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : "Notifications"}
                    className={cn(
                        "relative flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:bg-accent/50",
                        isNotificationsActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:text-foreground"
                    )}
                >
                    <Bell className="w-[18px] h-[18px]" />
                    {unreadCount > 0 && (
                        <span className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full text-[10px] h-4 min-w-4 px-1 flex items-center justify-center font-bold border-2 border-card">
                            {unreadCount > 9 ? "9+" : unreadCount}
                        </span>
                    )}
                </Link>

                <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
                    <DropdownMenuTrigger className="focus:outline-none">
                        <div className="flex items-center gap-3 px-3 py-2 rounded-lg transition-all hover:bg-accent/50 group max-w-[220px]">
                            <div className={cn(
                                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border border-border shadow-sm overflow-hidden",
                                getAvatarBg()
                            )}>
                                <span className="text-xs font-bold text-white">
                                    {getInitials()}
                                </span>
                            </div>
                            <div className="flex flex-col min-w-0 text-left hidden sm:flex">
                                <p className="text-[13px] font-medium text-foreground truncate leading-none mb-1">
                                    {name || "User"}
                                </p>
                                <p className="text-[11px] text-muted-foreground truncate leading-none">
                                    {email || "user@platform.com"}
                                </p>
                            </div>
                            <ChevronDown className={cn(
                                "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ml-1",
                                isDropdownOpen && "rotate-180"
                            )} />
                        </div>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[240px] p-0 overflow-hidden bg-card border-border shadow-md">
                        {/* Header Block - Non-clickable */}
                        <div className="flex flex-col space-y-0.5 p-3 px-[12px] bg-accent/5">
                            <p className="text-[13px] font-medium text-foreground truncate">{name || "User"}</p>
                            <p className="text-[12px] text-muted-foreground truncate overflow-hidden whitespace-nowrap">
                                {email || "user@platform.com"}
                            </p>
                        </div>

                        <DropdownMenuSeparator className="m-0 bg-border/40" />

                        {/* Metadata Section */}
                        <div className="p-[8px] px-[12px] space-y-1">
                            <p className="text-[12px] text-muted-foreground truncate leading-tight">
                                {isLoadingWorkspaces ? "..." : (currentWorkspace?.name || tenantSlug)}
                            </p>
                            <div className="flex items-center gap-1.5 text-[12px] leading-tight">
                                <span className="text-foreground capitalize">{plan || "Free"}</span>
                                {isStarterPlan && (
                                    <>
                                        <span className="text-muted-foreground/30 font-light translate-y-[-1px]">·</span>
                                        <Link 
                                            href={`/${tenantSlug}/dashboard/billing`}
                                            className="text-blue-500/80 hover:text-blue-400 font-medium transition-colors"
                                        >
                                            Upgrade
                                        </Link>
                                    </>
                                )}
                            </div>
                        </div>

                        <DropdownMenuSeparator className="m-0 bg-border/40" />

                        {/* Navigation Section */}
                        <div className="p-[4px] px-[4px]">
                            <DropdownMenuItem 
                                className="flex items-center px-[12px] py-[8px] cursor-pointer text-[13px] rounded-sm focus:bg-accent/50 focus:text-accent-foreground"
                                onClick={() => router.push(`/${tenantSlug}/dashboard/settings/profile`)}
                            >
                                <User className="mr-2 h-4 w-4 opacity-70" />
                                <span>Profile settings</span>
                            </DropdownMenuItem>
                            
                            <DropdownMenuSeparator className="my-[4px] bg-border/40 mx-[-4px]" />
                            
                            <DropdownMenuItem 
                                className="flex items-center px-[12px] py-[8px] cursor-pointer text-[13px] rounded-sm text-muted-foreground hover:text-foreground focus:bg-accent/50 focus:text-accent-foreground group"
                                onClick={() => signOut()}
                            >
                                <LogOut className="mr-2 h-4 w-4 opacity-70 group-hover:opacity-100 transition-opacity" />
                                <span>Sign out</span>
                            </DropdownMenuItem>
                        </div>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </header>
    )
}
