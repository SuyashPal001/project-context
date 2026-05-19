'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { ChevronDown, Loader2, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { pmKeys } from '@/lib/query-keys/pm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
    DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { type Member, type Priority, PRIORITY_CONFIG } from './_types'

const createMilestoneSchema = z.object({
    title:       z.string().min(1, 'Title is required').max(200),
    description: z.string().optional(),
    targetDate:  z.string().optional(),
    priority:    z.enum(['low', 'medium', 'high', 'urgent']).optional(),
})
type CreateMilestoneForm = z.infer<typeof createMilestoneSchema>

export function CreateMilestoneDialog({
    open, onOpenChange, planId, members,
}: {
    open: boolean
    onOpenChange: (v: boolean) => void
    planId: string
    members: Member[]
}) {
    const queryClient = useQueryClient()
    const [selectedAssigneeId, setSelectedAssigneeId] = useState<string | null>(null)
    const [selectedPriority, setSelectedPriority] = useState<Priority>('medium')
    const { register, handleSubmit, reset, formState: { errors } } = useForm<CreateMilestoneForm>({
        resolver: zodResolver(createMilestoneSchema),
    })

    const mutation = useMutation({
        mutationFn: (data: CreateMilestoneForm) => api.post(`/api/v1/plans/${planId}/milestones`, {
            title:       data.title,
            description: data.description || undefined,
            targetDate:  data.targetDate ? new Date(data.targetDate).toISOString() : undefined,
            priority:    selectedPriority,
            assigneeId:  selectedAssigneeId || undefined,
        }),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: pmKeys.milestones(planId) })
            queryClient.invalidateQueries({ queryKey: pmKeys.planSummary(planId) })
            toast.success('Milestone created')
            handleReset()
            onOpenChange(false)
        },
        onError: () => toast.error('Failed to create milestone'),
    })

    const handleReset = () => {
        reset()
        setSelectedAssigneeId(null)
        setSelectedPriority('medium')
    }

    return (
        <Dialog open={open} onOpenChange={v => { if (!v) handleReset(); onOpenChange(v) }}>
            <DialogContent className="bg-[#0f0f0f] border-[#1e1e1e]">
                <DialogHeader>
                    <DialogTitle>New Milestone</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSubmit(d => mutation.mutate(d))} className="space-y-4 pt-2">
                    <div className="space-y-1.5">
                        <Label>Title <span className="text-destructive">*</span></Label>
                        <Input {...register('title')} placeholder="Milestone title" className="bg-[#1a1a1a] border-[#2a2a2a]" autoFocus />
                        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                        <Label>Description <span className="text-xs text-muted-foreground">(optional)</span></Label>
                        <Textarea {...register('description')} placeholder="What needs to be done?" rows={2} className="bg-[#1a1a1a] border-[#2a2a2a] resize-none" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                            <Label>Target Date</Label>
                            <Input {...register('targetDate')} type="date" className="bg-[#1a1a1a] border-[#2a2a2a]" />
                        </div>
                        <div className="space-y-1.5">
                            <Label>Priority</Label>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex items-center gap-1.5 w-full px-3 py-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] text-sm text-foreground hover:bg-[#222] transition-colors">
                                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: PRIORITY_CONFIG[selectedPriority].color }} />
                                        {PRIORITY_CONFIG[selectedPriority].label}
                                        <ChevronDown className="w-3.5 h-3.5 ml-auto opacity-50" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                                    {(Object.entries(PRIORITY_CONFIG) as [Priority, typeof PRIORITY_CONFIG[Priority]][]).map(([k, cfg]) => (
                                        <DropdownMenuItem key={k} className="text-xs gap-2" onSelect={() => setSelectedPriority(k)}>
                                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: cfg.color }} />
                                            {cfg.label}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    </div>
                    {members.length > 0 && (
                        <div className="space-y-1.5">
                            <Label>Assignee <span className="text-xs text-muted-foreground">(optional)</span></Label>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button className="flex items-center gap-1.5 w-full px-3 py-2 rounded-md border border-[#2a2a2a] bg-[#1a1a1a] text-sm text-foreground hover:bg-[#222] transition-colors">
                                        <Users className="w-3.5 h-3.5 opacity-50" />
                                        {selectedAssigneeId
                                            ? (members.find(m => m.userId === selectedAssigneeId)?.userName ?? 'Unknown')
                                            : 'No assignee'}
                                        <ChevronDown className="w-3.5 h-3.5 ml-auto opacity-50" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]">
                                    <DropdownMenuItem className="text-xs" onSelect={() => setSelectedAssigneeId(null)}>
                                        No assignee
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                    {members.map(m => (
                                        <DropdownMenuItem key={m.userId} className="text-xs" onSelect={() => setSelectedAssigneeId(m.userId)}>
                                            {m.userName || m.userEmail}
                                        </DropdownMenuItem>
                                    ))}
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    )}
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => { handleReset(); onOpenChange(false) }}>Cancel</Button>
                        <Button type="submit" disabled={mutation.isPending}>
                            {mutation.isPending ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Creating…</> : 'Create Milestone'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
