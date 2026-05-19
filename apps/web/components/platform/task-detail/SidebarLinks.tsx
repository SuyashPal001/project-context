'use client'

import { useState } from 'react'
import { Link2, Pencil, X, Copy, ExternalLink } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { extractDomain } from './outputHelpers'
import { copyToClipboard, truncateUrl } from './_sidebarHelpers'

interface SidebarLinksProps {
    links: string[]
    isEditing: boolean
    newLinkInputRef: React.RefObject<HTMLInputElement | null>
    onAddLink: (url: string) => void
    onRemoveLink: (url: string) => void
}

export function SidebarLinks({ links, isEditing, newLinkInputRef, onAddLink, onRemoveLink }: SidebarLinksProps) {
    const [newLink, setNewLink] = useState('')

    return (
        <div id="links-section" className="flex flex-col py-2.5 border-b border-[#1a1a1a]">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <Link2 className="w-3.5 h-3.5 opacity-50" />
                    <span className="text-xs">Links</span>
                </div>
            </div>
            <div className="space-y-1.5 mb-2">
                {links.map((link, i) => (
                    <div key={i} className="flex items-center gap-1.5 group/link rounded px-1 py-0.5 hover:bg-white/5 transition-all">
                        <img
                            src={`https://www.google.com/s2/favicons?domain=${extractDomain(link)}&sz=16`}
                            alt=""
                            width={12}
                            height={12}
                            className="shrink-0 opacity-70"
                            onError={(e) => { e.currentTarget.style.display = 'none' }}
                        />
                        <Popover>
                            <PopoverTrigger asChild>
                                <button className="text-[11px] text-primary hover:underline truncate flex-1 leading-none text-left">
                                    {truncateUrl(link)}
                                </button>
                            </PopoverTrigger>
                            <PopoverContent className="w-72 p-3 space-y-2" side="left" align="start">
                                <p className="text-xs text-muted-foreground break-all select-text leading-relaxed">{link}</p>
                                <div className="flex gap-2">
                                    <a href={link} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                                        <ExternalLink className="w-3 h-3" /> Open
                                    </a>
                                    <button onClick={() => copyToClipboard(link)} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                                        <Copy className="w-3 h-3" /> Copy
                                    </button>
                                </div>
                            </PopoverContent>
                        </Popover>
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/link:opacity-100 transition-all shrink-0">
                            <button
                                onClick={() => { onRemoveLink(link); setNewLink(link); setTimeout(() => newLinkInputRef.current?.focus(), 50) }}
                                className="p-0.5 hover:bg-white/10 rounded transition-all"
                                title="Edit link"
                            >
                                <Pencil className="w-3 h-3 text-muted-foreground" />
                            </button>
                            <button onClick={() => onRemoveLink(link)} className="p-0.5 hover:bg-red-500/10 rounded transition-all" title="Remove link">
                                <X className="w-3 h-3 text-red-400" />
                            </button>
                        </div>
                    </div>
                ))}
                {links.length === 0 && (
                    <span className="text-[11px] text-muted-foreground/40 italic">No links added</span>
                )}
            </div>
            {isEditing && (
                <div className="flex items-center gap-1 mt-1">
                    <input
                        ref={newLinkInputRef}
                        value={newLink}
                        onChange={(e) => setNewLink(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && newLink.trim()) {
                                onAddLink(newLink.trim())
                                setNewLink('')
                            }
                        }}
                        placeholder="Paste URL and press Enter…"
                        className="text-[10px] bg-[#1a1a1a] border border-[#2a2a2a] rounded px-1.5 py-1 flex-1 outline-none focus:border-primary/50 transition-colors"
                    />
                </div>
            )}
        </div>
    )
}
