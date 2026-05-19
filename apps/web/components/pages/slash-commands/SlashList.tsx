'use client'

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react'
import { FileText, Type, List, ListOrdered, CheckSquare, Code, Quote, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface SlashItem {
    id: string
    title: string
    description: string
    group: 'template' | 'format'
}

interface SlashListProps {
    items: SlashItem[]
    command: (item: SlashItem) => void
}

export interface SlashListRef {
    onKeyDown: (props: { event: KeyboardEvent }) => boolean
}

const FORMAT_ICONS: Record<string, React.ReactNode> = {
    heading1:    <Type className="w-3.5 h-3.5" />,
    heading2:    <Type className="w-3 h-3" />,
    heading3:    <Type className="w-2.5 h-2.5" />,
    bulletList:  <List className="w-3.5 h-3.5" />,
    orderedList: <ListOrdered className="w-3.5 h-3.5" />,
    taskList:    <CheckSquare className="w-3.5 h-3.5" />,
    codeBlock:   <Code className="w-3.5 h-3.5" />,
    blockquote:  <Quote className="w-3.5 h-3.5" />,
    divider:     <Minus className="w-3.5 h-3.5" />,
}

export const SlashList = forwardRef<SlashListRef, SlashListProps>(
    ({ items, command }, ref) => {
        const [selectedIndex, setSelectedIndex] = useState(0)

        useEffect(() => setSelectedIndex(0), [items])

        const selectItem = (index: number) => {
            const item = items[index]
            if (item) command(item)
        }

        useImperativeHandle(ref, () => ({
            onKeyDown: ({ event }: { event: KeyboardEvent }) => {
                if (event.key === 'ArrowUp') {
                    setSelectedIndex(i => (i + items.length - 1) % Math.max(items.length, 1))
                    return true
                }
                if (event.key === 'ArrowDown') {
                    setSelectedIndex(i => (i + 1) % Math.max(items.length, 1))
                    return true
                }
                if (event.key === 'Enter') {
                    selectItem(selectedIndex)
                    return true
                }
                return false
            },
        }))

        if (items.length === 0) {
            return (
                <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-xl px-3 py-2 text-xs text-muted-foreground/50 w-56">
                    No results
                </div>
            )
        }

        const templates = items.filter(i => i.group === 'template')
        const formats   = items.filter(i => i.group === 'format')

        return (
            <div className="bg-[#1a1a1a] border border-[#2a2a2a] rounded-lg shadow-xl overflow-hidden w-56 py-1">
                {templates.length > 0 && (
                    <>
                        <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider">Templates</p>
                        {templates.map((item) => {
                            const idx = items.indexOf(item)
                            return (
                                <button
                                    key={item.id}
                                    onMouseDown={e => { e.preventDefault(); selectItem(idx) }}
                                    className={cn(
                                        'flex items-center gap-2.5 w-full px-3 py-1.5 text-left transition-colors',
                                        idx === selectedIndex ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-[#222]',
                                    )}
                                >
                                    <div className="w-6 h-6 rounded bg-[#2a2a2a] flex items-center justify-center shrink-0">
                                        <FileText className="w-3.5 h-3.5 text-primary/70" />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="text-xs font-medium truncate">{item.title}</p>
                                        <p className="text-[10px] text-muted-foreground/50 truncate">{item.description}</p>
                                    </div>
                                </button>
                            )
                        })}
                    </>
                )}
                {formats.length > 0 && (
                    <>
                        <p className="px-3 pt-2 pb-0.5 text-[10px] font-medium text-muted-foreground/40 uppercase tracking-wider">Format</p>
                        {formats.map((item) => {
                            const idx = items.indexOf(item)
                            return (
                                <button
                                    key={item.id}
                                    onMouseDown={e => { e.preventDefault(); selectItem(idx) }}
                                    className={cn(
                                        'flex items-center gap-2.5 w-full px-3 py-1.5 text-left text-xs transition-colors',
                                        idx === selectedIndex ? 'bg-primary/10 text-foreground' : 'text-foreground/80 hover:bg-[#222]',
                                    )}
                                >
                                    <div className="w-6 h-6 rounded bg-[#2a2a2a] flex items-center justify-center shrink-0 text-muted-foreground">
                                        {FORMAT_ICONS[item.id] ?? <Type className="w-3 h-3" />}
                                    </div>
                                    <span className="truncate">{item.title}</span>
                                </button>
                            )
                        })}
                    </>
                )}
            </div>
        )
    },
)
SlashList.displayName = 'SlashList'
