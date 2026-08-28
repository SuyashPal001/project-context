'use client'

import { useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { api, ApiError } from '@/lib/api'
import { toast } from 'sonner'
import { Plus, X, Loader2, Bot, ChevronDown, ChevronUp, Paperclip, FileText, Link2, User, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuTrigger,
    DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { PRIORITY_CONFIG } from './types'
import { StatusIcon } from './TaskCard'
import { AddLinkDialog } from './AddLinkDialog'
import { ReferenceDocumentDialog } from './ReferenceDocumentDialog'
import { ApproveCost } from '../credits/ApproveCost'
import type { AgentsResponse, MembersResponse, Assignee } from './types'

const createTaskSchema = z.object({
    title: z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    estimatedHours: z.string().optional(),
    acceptanceCriteria: z.array(z.object({ text: z.string() })),
})
type CreateTaskForm = z.infer<typeof createTaskSchema>

export function CreateTaskDialog({
    open,
    onOpenChange,
    defaultMilestoneId,
    defaultPlanId,
    defaultParentTaskId,
}: {
    open: boolean
    onOpenChange: (v: boolean) => void
    defaultMilestoneId?: string
    defaultPlanId?: string
    defaultParentTaskId?: string
}) {
    const queryClient = useQueryClient()
    const milestoneId = defaultMilestoneId ?? null
    const planId = defaultPlanId ?? null
    const parentTaskId = defaultParentTaskId ?? null

    const { data: agentsData } = useQuery<AgentsResponse>({
        queryKey: ['agents'],
        queryFn: () => api.get<AgentsResponse>('/api/v1/agents'),
        enabled: open,
    })
    const { data: membersData } = useQuery<MembersResponse>({
        queryKey: ['members'],
        queryFn: () => api.get<MembersResponse>('/api/v1/members'),
        enabled: open,
    })

    const activeAgents = agentsData?.data?.filter(a => a.status === 'active') ?? []
    const members = (membersData?.members ?? []).filter(m => m.status === 'active' && m.userId)

    const [selectedAssignee, setSelectedAssignee] = useState<Assignee | null>(null)
    const [selectedPriority, setSelectedPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium')
    const [hoursEditing, setHoursEditing] = useState(false)
    const [criteriaExpanded, setCriteriaExpanded] = useState(false)
    const [links, setLinks] = useState<{ url: string; title: string }[]>([])
    const [linkDialogOpen, setLinkDialogOpen] = useState(false)
    const [referenceText, setReferenceText] = useState<string>('')
    const [referenceDialogOpen, setReferenceDialogOpen] = useState(false)
    const [attachmentFileIds, setAttachmentFileIds] = useState<{ fileId: string; name: string; size: number; type: string }[]>([])
    const [isUploadingAttachment, setIsUploadingAttachment] = useState(false)
    const attachFileInputRef = useRef<HTMLInputElement>(null)
    // Agent-assigned tasks cost credits — set once the form is submitted for
    // an agent assignee, which swaps the footer's submit button for the
    // estimate-and-approve control. Non-agent tasks (no assignee, or a human
    // member) skip this entirely and submit directly.
    const [pendingPayload, setPendingPayload] = useState<Record<string, unknown> | null>(null)
    // Forces ApproveCost into its "out of credits" state after a submit
    // comes back 402 — the estimate is a preview, not a reservation, so the
    // balance can run out between the estimate call and the actual spend.
    const [insufficientCredits, setInsufficientCredits] = useState(false)

    const { register, control, handleSubmit, reset, watch, formState: { errors } } = useForm<CreateTaskForm>({
        resolver: zodResolver(createTaskSchema as any),
        defaultValues: { acceptanceCriteria: [] as { text: string }[] },
    })
    const { fields, append, remove } = useFieldArray({ control, name: 'acceptanceCriteria' })
    const estimatedHoursVal = watch('estimatedHours')

    const handleAttachmentUpload = async (file: File) => {
        setIsUploadingAttachment(true)
        try {
            const { data } = await api.post<{ data: { fileId: string; uploadUrl: string } }>(
                '/api/v1/files/upload',
                { filename: file.name, contentType: file.type || 'application/octet-stream' }
            )
            const uploadRes = await fetch(data.uploadUrl, {
                method: 'PUT',
                body: file,
                headers: { 'Content-Type': file.type || 'application/octet-stream' },
            })
            if (!uploadRes.ok) throw new Error('Upload failed')
            await api.post(`/api/v1/files/${data.fileId}/confirm`, { size: file.size })
            setAttachmentFileIds(prev => [...prev, { fileId: data.fileId, name: file.name, size: file.size, type: file.type }])
            toast.success(`Attached ${file.name}`)
        } catch (error) {
            console.error('Upload failed:', error)
            toast.error('Failed to upload attachment')
        } finally {
            setIsUploadingAttachment(false)
        }
    }

    const { mutate, isPending } = useMutation({
        mutationFn: (payload: Record<string, unknown>) => api.post('/api/v1/tasks', payload),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['tasks'] })
            if (milestoneId) queryClient.invalidateQueries({ queryKey: ['milestoneTasks', milestoneId] })
            toast.success('Task created')
            reset()
            setLinks([])
            setReferenceText('')
            setAttachmentFileIds([])
            setSelectedAssignee(null)
            setSelectedPriority('medium')
            setPendingPayload(null)
            setInsufficientCredits(false)
            onOpenChange(false)
        },
        onError: (err: unknown) => {
            // 402 means insufficient credits — surface the same "out of
            // credits" state ApproveCost already knows how to render,
            // rather than a generic error toast.
            if (err instanceof ApiError && err.status === 402) {
                setInsufficientCredits(true)
                return
            }
            toast.error(err instanceof Error ? err.message : 'Failed to create task')
        },
    })

    const buildPayload = (data: CreateTaskForm) => {
        const hours = data.estimatedHours ? parseFloat(data.estimatedHours) : undefined
        return {
            agentId: selectedAssignee?.type === 'agent' ? selectedAssignee.id : undefined,
            assigneeId: selectedAssignee?.type === 'member' ? selectedAssignee.id : undefined,
            title: data.title,
            description: data.description || undefined,
            estimatedHours: hours && !isNaN(hours) ? hours : undefined,
            acceptanceCriteria: data.acceptanceCriteria.filter(c => c.text.trim()).map(c => ({ text: c.text.trim(), checked: false })),
            priority: selectedPriority,
            links: links.map(l => l.url),
            referenceText: referenceText || undefined,
            attachmentFileIds: attachmentFileIds.map(f => f.fileId),
            milestoneId,
            planId,
            parentTaskId,
        }
    }

    const onSubmit = (data: CreateTaskForm) => {
        const payload = buildPayload(data)
        // Only agent-assigned tasks spend credits — a human assignee (or no
        // assignee) submits directly, same as before this feature existed.
        if (selectedAssignee?.type === 'agent') {
            setInsufficientCredits(false)
            setPendingPayload(payload)
            return
        }
        mutate(payload)
    }

    const handleApprove = (idempotencyKey: string) => {
        if (!pendingPayload) return
        mutate({ ...pendingPayload, idempotencyKey })
    }

    const handleCancelApprove = () => {
        setPendingPayload(null)
        setInsufficientCredits(false)
    }

    return (
        <Dialog open={open} onOpenChange={(v) => { if (!v) { reset(); setPendingPayload(null); setInsufficientCredits(false); onOpenChange(v) } }}>
            <DialogContent className="max-w-2xl bg-[#0f0f0f] border-[#1e1e1e] rounded-xl p-0 gap-0 overflow-hidden [&>button]:hidden shadow-2xl">
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col">
                    <input
                        placeholder="Task title"
                        className="w-full bg-transparent text-xl font-medium text-foreground placeholder:text-muted-foreground/30 border-none outline-none resize-none px-6 pt-6 pb-2"
                        {...register('title')}
                        autoFocus
                    />
                    {/* Properties row */}
                    <div className="flex items-center gap-2 px-6 py-3 border-y border-[#1e1e1e] flex-wrap">
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground border border-[#1e1e1e] hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer select-none outline-none">
                                    {selectedAssignee?.type === 'agent' ? <Bot className="w-3.5 h-3.5 shrink-0" /> : <User className="w-3.5 h-3.5 shrink-0" />}
                                    <span>{selectedAssignee?.name ?? 'No Assignee'}</span>
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a] text-xs" align="start">
                                <DropdownMenuItem className="gap-1.5 text-xs" onSelect={() => setSelectedAssignee(null)}>
                                    <User className="w-3.5 h-3.5" /> No Assignee
                                </DropdownMenuItem>
                                {members.length > 0 && (
                                    <>
                                        <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                        <DropdownMenuLabel className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-2 py-1">Members</DropdownMenuLabel>
                                        {members.map(m => (
                                            <DropdownMenuItem key={m.userId} className="gap-1.5 text-xs" onSelect={() => setSelectedAssignee({ type: 'member', id: m.userId, name: m.userName || m.userEmail })}>
                                                <User className="w-3.5 h-3.5" />{m.userName || m.userEmail}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                )}
                                {activeAgents.length > 0 && (
                                    <>
                                        <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                        <DropdownMenuLabel className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-2 py-1">Agents</DropdownMenuLabel>
                                        {activeAgents.map(a => (
                                            <DropdownMenuItem key={a.id} className="gap-1.5 text-xs" onSelect={() => setSelectedAssignee({ type: 'agent', id: a.id, name: a.name })}>
                                                <Bot className="w-3.5 h-3.5" />{a.name}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground border border-[#1e1e1e]">
                            <StatusIcon status="backlog" /><span>Backlog</span>
                        </div>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground border border-[#1e1e1e] hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer select-none outline-none">
                                    <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: PRIORITY_CONFIG[selectedPriority].color }} />
                                    <span>{PRIORITY_CONFIG[selectedPriority].label}</span>
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]" align="start">
                                {(Object.entries(PRIORITY_CONFIG) as [keyof typeof PRIORITY_CONFIG, typeof PRIORITY_CONFIG[keyof typeof PRIORITY_CONFIG]][]).map(([key, cfg]) => (
                                    <DropdownMenuItem key={key} className="gap-1.5 text-xs" onSelect={() => setSelectedPriority(key)}>
                                        <div className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: cfg.color }} />{cfg.label}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {hoursEditing ? (
                            <input type="number" min="0" step="0.5" placeholder="hours" autoFocus
                                className="w-20 bg-transparent text-xs text-foreground border border-[#3a3a3a] rounded-md px-2.5 py-1 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                {...register('estimatedHours')} onBlur={() => setHoursEditing(false)} />
                        ) : (
                            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer border border-[#1e1e1e]" onClick={() => setHoursEditing(true)}>
                                <Clock className="w-3.5 h-3.5" /><span>{estimatedHoursVal ? `${estimatedHoursVal}h` : 'Est. hours'}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer border border-[#1e1e1e]" onClick={() => setLinkDialogOpen(true)}>
                            <Link2 className="w-3.5 h-3.5" /><span>{links.length > 0 ? `${links.length} link${links.length > 1 ? 's' : ''}` : 'Add link'}</span>
                        </div>
                        <div className={cn("flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer border border-[#1e1e1e]", isUploadingAttachment && "opacity-50 cursor-wait")}
                            onClick={() => !isUploadingAttachment && attachFileInputRef.current?.click()}>
                            {isUploadingAttachment ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Paperclip className="w-3.5 h-3.5" />}
                            <span>{attachmentFileIds.length > 0 ? `${attachmentFileIds.length} file${attachmentFileIds.length > 1 ? 's' : ''}` : 'Attach'}</span>
                        </div>
                        <input type="file" ref={attachFileInputRef} className="hidden" onChange={(e) => { const file = e.target.files?.[0]; if (file) handleAttachmentUpload(file); e.target.value = '' }} />
                        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted-foreground hover:bg-[#1a1a1a] hover:text-foreground transition-colors cursor-pointer border border-[#1e1e1e]" onClick={() => setReferenceDialogOpen(true)}>
                            <FileText className="w-3.5 h-3.5" /><span>{referenceText ? '1 ref' : 'Add reference'}</span>
                        </div>
                    </div>

                    {/* Links list */}
                    {links.length > 0 && (
                        <div className="space-y-1 px-6 pt-2">
                            {links.map((link, i) => (
                                <div key={i} className="flex items-center gap-1.5 group/link rounded px-1.5 py-1 bg-white/5 text-xs">
                                    <span className="truncate flex-1 text-primary/80">{link.title || link.url}</span>
                                    <button type="button" onClick={() => setLinks(p => p.filter((_, j) => j !== i))} className="opacity-0 group-hover/link:opacity-100 p-0.5 hover:bg-red-500/10 rounded transition-all shrink-0">
                                        <X className="w-3 h-3 text-red-400" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Attachments list */}
                    {attachmentFileIds.length > 0 && (
                        <div className="flex flex-col gap-1 px-6 pt-3 pb-1">
                            {attachmentFileIds.map((f) => (
                                <div key={f.fileId} className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-[#1a1a1a] border border-[#2a2a2a] group">
                                    <Paperclip className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                    <span className="flex-1 text-xs text-foreground truncate">{f.name}</span>
                                    <span className="text-[10px] text-muted-foreground/50 shrink-0">{f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}</span>
                                    <button type="button" className="text-muted-foreground/40 hover:text-foreground transition-colors shrink-0" onClick={() => setAttachmentFileIds(prev => prev.filter(a => a.fileId !== f.fileId))}>
                                        <X className="w-3 h-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <textarea placeholder="Add description..." className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground/30 border-none outline-none resize-none px-6 py-4 min-h-[100px]" {...register('description')} />

                    {/* Acceptance Criteria */}
                    <div className="pb-4">
                        <button type="button" className="flex items-center gap-1.5 text-xs text-muted-foreground px-6 py-2 hover:text-foreground outline-none border-none bg-transparent" onClick={() => setCriteriaExpanded(!criteriaExpanded)}>
                            {criteriaExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                            Acceptance Criteria {fields.length > 0 && `(${fields.length})`}
                        </button>
                        {criteriaExpanded && (
                            <div className="space-y-2 mt-1">
                                {fields.map((field, index) => (
                                    <div key={field.id} className="flex items-center gap-2 px-6 group/item">
                                        <div className="w-3.5 h-3.5 rounded-[3px] border border-[#3a3a3a] bg-transparent flex-shrink-0" />
                                        <input type="text" placeholder="Add acceptance criterion..." className="flex-1 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground/30" {...register(`acceptanceCriteria.${index}.text`)} />
                                        <button type="button" className="text-muted-foreground/40 hover:text-muted-foreground opacity-0 group-hover/item:opacity-100 transition-opacity" onClick={() => remove(index)}>
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                ))}
                                <div className="px-6 pt-1">
                                    <button type="button" className="text-xs text-muted-foreground/60 hover:text-muted-foreground flex items-center gap-1.5 bg-transparent border-none" onClick={() => append({ text: '' })}>
                                        <Plus className="h-3.5 w-3.5" /> Add criterion
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Footer */}
                    {pendingPayload ? (
                        <div className="border-t border-[#1e1e1e]">
                            <ApproveCost
                                resourceType="tool_call"
                                subject="task.create"
                                onApprove={handleApprove}
                                onCancel={handleCancelApprove}
                                insufficientOverride={insufficientCredits}
                            />
                        </div>
                    ) : (
                        <div className="flex items-center justify-between px-6 py-4 border-t border-[#1e1e1e]">
                            <div className="flex flex-col">
                                <span className="text-xs text-muted-foreground/40 flex items-center gap-1.5">
                                    <Bot className="w-3.5 h-3.5" /> Move to Todo to start planning
                                </span>
                                {errors.title && <span className="text-[10px] text-destructive mt-1">{errors.title.message}</span>}
                            </div>
                            <div className="flex items-center gap-2">
                                <Button type="button" variant="ghost" className="text-sm text-muted-foreground hover:text-foreground" onClick={() => { reset(); onOpenChange(false) }}>Cancel</Button>
                                <Button type="submit" disabled={isPending} className="bg-[#2a2a2a] hover:bg-[#333] text-white border border-[#3a3a3a] text-sm px-4 py-2 rounded-lg font-medium">
                                    {isPending ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Creating...</> : 'Create Task'}
                                </Button>
                            </div>
                        </div>
                    )}
                </form>
            </DialogContent>
            <AddLinkDialog open={linkDialogOpen} onOpenChange={setLinkDialogOpen} onAddLink={link => setLinks(p => [...p, link])} />
            <ReferenceDocumentDialog open={referenceDialogOpen} onOpenChange={setReferenceDialogOpen} value={referenceText} onSave={setReferenceText} />
        </Dialog>
    )
}
