'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, FileText, Lock, Bot, Loader2, MoreHorizontal, Trash2 } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { pagesKeys } from '@/lib/query-keys/pm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
    AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
    AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'

// ─── Types ────────────────────────────────────────────────────────────────────

type Page = {
    id: string
    title: string
    pageType: string
    source: string
    isLocked: boolean
    updatedAt: string
}

type CreatePageResponse = { data: Page }

// ─── Constants ────────────────────────────────────────────────────────────────

const TYPE_CFG: Record<string, { label: string; color: string; bg: string }> = {
    prd:     { label: 'PRD',     color: 'text-violet-400', bg: 'bg-violet-500/10' },
    roadmap: { label: 'Roadmap', color: 'text-blue-400',   bg: 'bg-blue-500/10'   },
    runbook: { label: 'Runbook', color: 'text-orange-400', bg: 'bg-orange-500/10' },
    adr:     { label: 'ADR',     color: 'text-amber-400',  bg: 'bg-amber-500/10'  },
    manual:  { label: 'Manual',  color: 'text-teal-400',   bg: 'bg-teal-500/10'   },
    custom:  { label: 'Custom',  color: 'text-gray-400',   bg: 'bg-gray-500/10'   },
}

// ─── PagesListPage ────────────────────────────────────────────────────────────

// ─── PageRow ──────────────────────────────────────────────────────────────────

function PageRow({ page, planId, tenantSlug, onNavigate }: {
    page: Page
    planId: string
    tenantSlug: string
    onNavigate: () => void
}) {
    const queryClient = useQueryClient()
    const [deleteOpen, setDeleteOpen] = useState(false)
    const cfg = TYPE_CFG[page.pageType] ?? TYPE_CFG.custom

    const deletePage = useMutation({
        mutationFn: () => api.del(`/api/v1/pages/${page.id}`),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pagesKeys.list(planId) })
            toast.success('Page deleted')
        },
        onError: () => toast.error('Failed to delete page'),
    })

    return (
        <>
            <div
                onClick={onNavigate}
                className="flex items-center gap-3 bg-[#111111] border border-[#1e1e1e] rounded-lg px-4 py-3 cursor-pointer hover:border-[#2a2a2a] transition-colors"
            >
                <FileText className="w-4 h-4 text-muted-foreground/40 shrink-0" />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{page.title}</p>
                    <p className="text-[10px] text-muted-foreground/40 mt-0.5">
                        Updated {formatDistanceToNow(new Date(page.updatedAt), { addSuffix: true })}
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={cn('text-[10px] px-1.5 py-0.5 rounded font-medium', cfg.bg, cfg.color)}>
                        {cfg.label}
                    </span>
                    {page.source === 'agent' && (
                        <span className="flex items-center gap-1 text-[10px] text-blue-400/70 bg-blue-500/10 px-1.5 py-0.5 rounded">
                            <Bot className="w-3 h-3" />Agent
                        </span>
                    )}
                    {page.isLocked && <Lock className="w-3.5 h-3.5 text-amber-500/60" />}
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button
                                onClick={e => e.stopPropagation()}
                                className="text-muted-foreground/30 hover:text-muted-foreground transition-colors p-0.5 rounded"
                                aria-label="Page options"
                            >
                                <MoreHorizontal className="w-4 h-4" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            className="bg-[#1a1a1a] border-[#2a2a2a]"
                            align="end"
                            onClick={e => e.stopPropagation()}
                        >
                            <DropdownMenuItem
                                className="text-xs text-destructive focus:text-destructive focus:bg-destructive/10"
                                onSelect={() => setDeleteOpen(true)}
                            >
                                <Trash2 className="w-3.5 h-3.5 mr-2" />
                                Delete
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                <AlertDialogContent className="bg-[#0f0f0f] border-[#1e1e1e]">
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete page?</AlertDialogTitle>
                        <AlertDialogDescription>
                            &ldquo;{page.title}&rdquo; will be permanently deleted.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => deletePage.mutate()}
                            disabled={deletePage.isPending}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                            {deletePage.isPending ? 'Deleting…' : 'Delete'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}

// ─── PagesListPage ────────────────────────────────────────────────────────────

export default function PagesListPage({ planId, tenantSlug }: { planId: string; tenantSlug: string }) {
    const router = useRouter()
    const queryClient = useQueryClient()

    const { data, isLoading, isError } = useQuery<{ data: Page[] }>({
        queryKey: pagesKeys.list(planId),
        queryFn: () => api.get(`/api/v1/pages?planId=${planId}`),
        enabled: !!planId,
    })

    const createPage = useMutation({
        mutationFn: (): Promise<CreatePageResponse> => {
            if (!planId) return Promise.reject(new Error('planId missing'))
            return api.post('/api/v1/pages', { planId, title: 'Untitled', pageType: 'custom' })
        },
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: pagesKeys.list(planId) })
            router.push(`/${tenantSlug}/dashboard/plans/${planId}/pages/${res.data.id}`)
        },
        onError: () => toast.error('Failed to create page'),
    })

    const pages = data?.data ?? []

    return (
        <div className="flex flex-col">
            <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-medium text-foreground">
                    Pages{pages.length > 0 && <span className="ml-2 text-muted-foreground/50">{pages.length}</span>}
                </h2>
                <Button size="sm" onClick={() => createPage.mutate()} disabled={createPage.isPending}>
                    {createPage.isPending
                        ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                        : <Plus className="w-4 h-4 mr-1.5" />}
                    New Page
                </Button>
            </div>

            {isLoading && (
                <div className="space-y-2">
                    {[1, 2, 3].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
                </div>
            )}

            {isError && <p className="text-sm text-destructive">Failed to load pages.</p>}

            {!isLoading && !isError && pages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-24 text-center">
                    <FileText className="w-10 h-10 text-muted-foreground/20 mb-3" />
                    <p className="text-sm font-medium text-muted-foreground">No pages yet</p>
                    <p className="text-xs text-muted-foreground/50 mt-1">Create your first page to document this plan</p>
                </div>
            )}

            {pages.length > 0 && (
                <div className="space-y-2">
                    {pages.map(page => (
                        <PageRow
                            key={page.id}
                            page={page}
                            planId={planId}
                            tenantSlug={tenantSlug}
                            onNavigate={() => router.push(`/${tenantSlug}/dashboard/plans/${planId}/pages/${page.id}`)}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
