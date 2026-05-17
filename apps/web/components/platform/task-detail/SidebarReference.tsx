'use client'

import { FileText } from 'lucide-react'

interface SidebarReferenceProps {
    referenceText: string | null | undefined
    isEditing: boolean
    referenceTextRef: React.RefObject<HTMLTextAreaElement | null>
    onSave: (text: string | null) => void
}

export function SidebarReference({ referenceText, isEditing, referenceTextRef, onSave }: SidebarReferenceProps) {
    return (
        <div id="reference-section" className="flex flex-col py-2.5 border-b border-[#1a1a1a]">
            <div className="flex items-center gap-2 text-muted-foreground mb-2">
                <FileText className="w-3.5 h-3.5 opacity-50" />
                <span className="text-xs">Reference</span>
            </div>
            {isEditing ? (
                <textarea
                    ref={referenceTextRef}
                    defaultValue={referenceText ?? ''}
                    onBlur={(e) => {
                        const val = e.target.value.trim()
                        if (val !== (referenceText ?? '').trim()) {
                            onSave(val || null)
                        }
                    }}
                    placeholder="Add reference notes, markdown content, or context…"
                    rows={3}
                    className="text-[11px] text-foreground/80 leading-relaxed bg-[#111] border border-[#1e1e1e] rounded-lg p-2.5 outline-none focus:border-primary/40 resize-none w-full placeholder:text-muted-foreground/30 transition-colors"
                />
            ) : (
                <p className="text-[11px] text-foreground/70 leading-relaxed whitespace-pre-wrap break-words">
                    {referenceText || <span className="text-muted-foreground/40 italic">No reference added</span>}
                </p>
            )}
        </div>
    )
}
