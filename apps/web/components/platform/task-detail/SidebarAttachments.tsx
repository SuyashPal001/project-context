'use client'

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Paperclip, X } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'

interface SidebarAttachmentsProps {
    attachmentFileIds: string[]
    isUploading: boolean
    attachFileInputRef: React.RefObject<HTMLInputElement | null>
    onRemoveAttachment: (fileId: string) => void
}

export function SidebarAttachments({ attachmentFileIds, isUploading, attachFileInputRef, onRemoveAttachment }: SidebarAttachmentsProps) {
    const hasAttachments = attachmentFileIds.length > 0

    const { data: filesData } = useQuery({
        queryKey: ['files'],
        queryFn: () => api.get<{ data: Array<{ id: string; filename: string }> }>('/api/v1/files'),
        enabled: hasAttachments,
        staleTime: 60_000,
    })

    const fileNameMap = useMemo(() => {
        const map: Record<string, string> = {}
        for (const f of filesData?.data ?? []) map[f.id] = f.filename
        return map
    }, [filesData])

    return (
        <div className="flex flex-col py-2.5 border-b border-[#1a1a1a]">
            <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-muted-foreground">
                    <Paperclip className="w-3.5 h-3.5 opacity-50" />
                    <span className="text-xs">Attachments</span>
                </div>
                <button
                    onClick={() => attachFileInputRef.current?.click()}
                    disabled={isUploading}
                    className="text-[10px] text-muted-foreground hover:text-foreground bg-[#1a1a1a] px-1.5 py-0.5 rounded border border-[#2a2a2a] disabled:cursor-not-allowed transition-colors"
                >
                    {isUploading ? '…' : '+ Add'}
                </button>
            </div>
            {hasAttachments ? (
                <div className="space-y-1">
                    {attachmentFileIds.map((fileId, i) => (
                        <div key={fileId} className="flex items-center justify-between group/att">
                            <button
                                className="text-[11px] text-primary hover:underline truncate flex-1 text-left"
                                onClick={async () => {
                                    try {
                                        const res = await api.get<{ data: { downloadUrl: string } }>(`/api/v1/files/${fileId}/download`)
                                        window.open(res.data.downloadUrl, '_blank')
                                    } catch {
                                        toast.error('Failed to open attachment')
                                    }
                                }}
                            >
                                {fileNameMap[fileId] ?? `Attachment ${i + 1}`}
                            </button>
                            <button
                                onClick={() => onRemoveAttachment(fileId)}
                                className="opacity-0 group-hover/att:opacity-100 p-0.5 hover:bg-red-500/10 rounded transition-all ml-1"
                            >
                                <X className="w-3 h-3 text-red-400" />
                            </button>
                        </div>
                    ))}
                </div>
            ) : (
                <span className="text-[11px] text-muted-foreground/40 italic">No attachments</span>
            )}
        </div>
    )
}
