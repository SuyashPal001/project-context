'use client'

import { useState } from 'react'
import { Bot, User, ChevronDown, Sparkles } from 'lucide-react'
import {
    DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
    DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { Task } from '@/types/task'
import { STATUS_CONFIG, PRIORITY_CONFIG, StatusIcon, PriorityIcon } from './_sidebarHelpers'

type Assignee = { type: 'agent' | 'member'; id: string; name: string }

interface SidebarEditableRowsProps {
    task: Task
    isEditing: boolean
    draftStatus: string
    draftPriority: string
    draftAssigneeKey: string
    setDraftStatus: (v: string) => void
    setDraftPriority: (v: string) => void
    setDraftAssigneeKey: (v: string) => void
    assigneeOptions: Assignee[]
    selectedAssignee: Assignee | null
}

export function SidebarEditableRows({
    task, isEditing, draftStatus, draftPriority, draftAssigneeKey,
    setDraftStatus, setDraftPriority, setDraftAssigneeKey,
    assigneeOptions, selectedAssignee,
}: SidebarEditableRowsProps) {
    const [assigneeOpen, setAssigneeOpen] = useState(false)

    return (
        <>
            {/* Status */}
            <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                    <StatusIcon status={task.status} />
                    <span className="text-xs">Status</span>
                </div>
                <div className="text-xs text-foreground flex-1">
                    {isEditing ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <div className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 outline-none select-none">
                                    <span className={cn('font-medium', STATUS_CONFIG[draftStatus as keyof typeof STATUS_CONFIG]?.text)}>
                                        {STATUS_CONFIG[draftStatus as keyof typeof STATUS_CONFIG]?.label}
                                    </span>
                                    <ChevronDown className="w-3 h-3 opacity-40" />
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]" align="start">
                                {(['backlog', 'todo', 'in_progress', 'review', 'done', 'blocked'] as const).map((s) => (
                                    <DropdownMenuItem key={s} className="text-xs cursor-pointer gap-2" onSelect={() => setDraftStatus(s)}>
                                        <StatusIcon status={s} />
                                        <span className={STATUS_CONFIG[s].text}>{STATUS_CONFIG[s].label}</span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <span className={cn('font-medium', STATUS_CONFIG[task.status as keyof typeof STATUS_CONFIG]?.text)}>
                            {STATUS_CONFIG[task.status as keyof typeof STATUS_CONFIG]?.label ?? task.status}
                        </span>
                    )}
                </div>
            </div>

            {/* Priority */}
            <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                    <PriorityIcon priority={isEditing ? draftPriority : task.priority} />
                    <span className="text-xs">Priority</span>
                </div>
                <div className="text-xs text-foreground flex-1">
                    {isEditing ? (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <div className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 outline-none select-none">
                                    <span className={cn('font-medium', PRIORITY_CONFIG[draftPriority as keyof typeof PRIORITY_CONFIG]?.text)}>
                                        {PRIORITY_CONFIG[draftPriority as keyof typeof PRIORITY_CONFIG]?.label}
                                    </span>
                                    <ChevronDown className="w-3 h-3 opacity-40" />
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a]" align="start">
                                {(['low', 'medium', 'high', 'urgent'] as const).map((p) => (
                                    <DropdownMenuItem key={p} className="text-xs cursor-pointer gap-2" onSelect={() => setDraftPriority(p)}>
                                        <PriorityIcon priority={p} />
                                        <span className={PRIORITY_CONFIG[p].text}>{PRIORITY_CONFIG[p].label}</span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <span className={cn('font-medium', PRIORITY_CONFIG[task.priority as keyof typeof PRIORITY_CONFIG]?.text)}>
                            {PRIORITY_CONFIG[task.priority as keyof typeof PRIORITY_CONFIG]?.label ?? task.priority}
                        </span>
                    )}
                </div>
            </div>

            {/* Assignee */}
            <div className="flex items-center gap-3 py-2.5 border-b border-[#1a1a1a]">
                <div className="flex items-center gap-2 w-[100px] flex-shrink-0 text-muted-foreground">
                    {selectedAssignee?.type === 'agent'
                        ? <Bot className="w-3.5 h-3.5 opacity-50" />
                        : <User className="w-3.5 h-3.5 opacity-50" />}
                    <span className="text-xs">Assignee</span>
                </div>
                <div className="text-xs text-foreground flex-1">
                    {isEditing ? (
                        <DropdownMenu open={assigneeOpen} onOpenChange={setAssigneeOpen}>
                            <DropdownMenuTrigger asChild>
                                <div className="flex items-center gap-1.5 cursor-pointer hover:opacity-80 outline-none select-none">
                                    <span>
                                        {draftAssigneeKey === 'unassigned'
                                            ? 'No Assignee'
                                            : assigneeOptions.find(o => `${o.type}:${o.id}` === draftAssigneeKey)?.name ?? 'No Assignee'}
                                    </span>
                                    <ChevronDown className="w-3 h-3 opacity-40" />
                                </div>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent className="bg-[#1a1a1a] border-[#2a2a2a] text-xs" align="start">
                                <DropdownMenuItem className="gap-1.5 text-xs" onSelect={() => setDraftAssigneeKey('unassigned')}>
                                    <User className="w-3.5 h-3.5" /> No Assignee
                                </DropdownMenuItem>
                                {assigneeOptions.filter(o => o.type === 'member').length > 0 && (
                                    <>
                                        <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                        <DropdownMenuLabel className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-2 py-1">Members</DropdownMenuLabel>
                                        {assigneeOptions.filter(o => o.type === 'member').map(m => (
                                            <DropdownMenuItem key={m.id} className="gap-1.5 text-xs" onSelect={() => setDraftAssigneeKey(`member:${m.id}`)}>
                                                <User className="w-3.5 h-3.5" />{m.name}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                )}
                                {assigneeOptions.filter(o => o.type === 'agent').length > 0 && (
                                    <>
                                        <DropdownMenuSeparator className="bg-[#2a2a2a]" />
                                        <DropdownMenuLabel className="text-[10px] text-muted-foreground/60 uppercase tracking-wider px-2 py-1">Agents</DropdownMenuLabel>
                                        {assigneeOptions.filter(o => o.type === 'agent').map(a => (
                                            <DropdownMenuItem key={a.id} className="gap-1.5 text-xs" onSelect={() => setDraftAssigneeKey(`agent:${a.id}`)}>
                                                <Bot className="w-3.5 h-3.5" />{a.name}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    ) : (
                        <span className="font-medium">{selectedAssignee?.name ?? 'No Assignee'}</span>
                    )}
                </div>
            </div>

            {!task.agentId && (task.status === 'backlog' || task.status === 'todo') && (
                <button
                    onClick={() => setAssigneeOpen(true)}
                    className="flex items-center gap-1.5 w-full rounded-md bg-purple-950/60 border border-purple-800/40 hover:bg-purple-950 hover:border-purple-800/70 px-2 py-1.5 transition-colors cursor-pointer text-left mt-1"
                >
                    <Sparkles className="w-3 h-3 text-purple-400 shrink-0" />
                    <span className="text-xs text-purple-300">Assign agent to auto-execute</span>
                </button>
            )}
        </>
    )
}
