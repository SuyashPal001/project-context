'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useParams } from 'next/navigation'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, Copy, Lock, Unlock, Loader2, History, X } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { pmKeys, pagesKeys } from '@/lib/query-keys/pm'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { PageEditor } from '@/components/pages/PageEditor'
import { PageVersions } from '@/components/pages/PageVersions'

// ─── Types ────────────────────────────────────────────────────────────────────

type Page = {
    id: string
    title: string
    descriptionHtml: string
    isLocked: boolean
}

type Plan = { id: string; title: string }

// ─── PageDetailPage ───────────────────────────────────────────────────────────

export default function PageDetailPage() {
    const router = useRouter()
    const params = useParams()
    const tenantSlug = params.tenant as string
    const planId = params.planId as string
    const pageId = params.pageId as string
    const queryClient = useQueryClient()

    const [editingTitle, setEditingTitle] = useState(false)
    const [draftTitle, setDraftTitle] = useState('')
    const [historyOpen, setHistoryOpen] = useState(false)

    const { data: pageData, isLoading, isError } = useQuery<{ data: Page }>({
        queryKey: pagesKeys.detail(pageId),
        queryFn: () => api.get(`/api/v1/pages/${pageId}`),
    })

    const { data: planData } = useQuery<{ data: Plan }>({
        queryKey: pmKeys.plan(planId),
        queryFn: () => api.get(`/api/v1/plans/${planId}`),
    })

    const patchTitle = useMutation({
        mutationFn: (title: string) => api.patch(`/api/v1/pages/${pageId}`, { title }),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: pagesKeys.detail(pageId) }),
        onError: () => toast.error('Failed to save title'),
    })

    const duplicate = useMutation({
        mutationFn: () => api.post(`/api/v1/pages/${pageId}/duplicate`, {}) as Promise<{ data: { id: string } }>,
        onSuccess: (res) => {
            queryClient.invalidateQueries({ queryKey: pagesKeys.list(planId) })
            toast.success('Page duplicated')
            router.push(`/${tenantSlug}/dashboard/plans/${planId}/pages/${res.data.id}`)
        },
        onError: () => toast.error('Failed to duplicate page'),
    })

    const toggleLock = useMutation({
        mutationFn: () => api.post(`/api/v1/pages/${pageId}/lock`, {}),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pagesKeys.detail(pageId) })
            toast.success(page?.isLocked ? 'Page unlocked' : 'Page locked')
        },
        onError: () => toast.error('Failed to toggle lock'),
    })

    const page = pageData?.data
    const plan = planData?.data

    if (isLoading) {
        return (
            <div className="space-y-4">
                <Skeleton className="h-3 w-48" />
                <Skeleton className="h-8 w-80" />
                <Skeleton className="h-64 w-full rounded-lg" />
            </div>
        )
    }

    if (isError || !page) return <p className="text-sm text-destructive">Failed to load page.</p>

    const base = `/${tenantSlug}/dashboard/plans`

    return (
        <>
        <div className="flex flex-col max-w-4xl">
            {/* Breadcrumb */}
            <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-5">
                <Link href={base} className="hover:text-foreground transition-colors">Plans</Link>
                <ChevronRight className="w-3 h-3" />
                <Link href={`${base}/${planId}`} className="hover:text-foreground transition-colors truncate max-w-[140px]">
                    {plan?.title ?? '…'}
                </Link>
                <ChevronRight className="w-3 h-3" />
                <Link href={`${base}/${planId}/pages`} className="hover:text-foreground transition-colors">Pages</Link>
                <ChevronRight className="w-3 h-3" />
                <span className="text-foreground truncate max-w-[160px]">{page.title}</span>
            </nav>

            {/* Header */}
            <div className="flex items-start justify-between gap-4 mb-6">
                <div className="flex-1 min-w-0">
                    {editingTitle ? (
                        <input
                            autoFocus
                            value={draftTitle}
                            onChange={e => setDraftTitle(e.target.value)}
                            onBlur={() => {
                                const t = draftTitle.trim()
                                if (t && t !== page.title) patchTitle.mutate(t)
                                setEditingTitle(false)
                            }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') { const t = draftTitle.trim(); if (t && t !== page.title) patchTitle.mutate(t); setEditingTitle(false) }
                                if (e.key === 'Escape') setEditingTitle(false)
                            }}
                            className="text-2xl font-semibold bg-transparent outline-none border-b border-primary/50 pb-0.5 w-full text-foreground"
                        />
                    ) : (
                        <h1
                            className="text-2xl font-semibold text-foreground cursor-text hover:opacity-80 transition-opacity"
                            onClick={() => { setDraftTitle(page.title); setEditingTitle(true) }}
                        >
                            {page.title}
                        </h1>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
                        onClick={() => setHistoryOpen(v => !v)}
                        title="Version history"
                    >
                        <History className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
                        onClick={() => duplicate.mutate()}
                        disabled={duplicate.isPending}
                        title="Duplicate page"
                    >
                        {duplicate.isPending
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : <Copy className="w-3.5 h-3.5" />}
                    </Button>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0 gap-1.5 text-muted-foreground hover:text-foreground"
                        onClick={() => toggleLock.mutate()}
                        disabled={toggleLock.isPending}
                    >
                        {toggleLock.isPending
                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            : page.isLocked
                                ? <><Unlock className="w-3.5 h-3.5" />Unlock</>
                                : <><Lock className="w-3.5 h-3.5" />Lock</>}
                    </Button>
                </div>
            </div>

            {/* Editor */}
            <PageEditor
                pageId={pageId}
                initialHtml={page.descriptionHtml}
                isLocked={page.isLocked}
            />
        </div>

        {/* Backdrop */}
        {historyOpen && (
            <div
                className="fixed inset-0 bg-black/20 z-40"
                onClick={() => setHistoryOpen(false)}
            />
        )}

        {/* History sidebar */}
        <div
            className={`fixed top-0 right-0 h-full w-80 z-50 bg-background border-l border-border flex flex-col transition-transform duration-300 ${historyOpen ? 'translate-x-0' : 'translate-x-full'}`}
        >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
                <span className="text-sm font-medium">Version History</span>
                <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => setHistoryOpen(false)}>
                    <X className="w-4 h-4" />
                </Button>
            </div>
            <div className="overflow-y-auto flex-1">
                <PageVersions pageId={pageId} />
            </div>
        </div>
        </>
    )
}
