'use client';

// Third instance of the "agent needs a decision/input from you" shell —
// see ClarificationCard.tsx's header comment. This one pairs the shell with
// a drag-and-drop dropzone instead of numbered options, for when the agent
// needs the user to actually upload a file (a logo, screenshots) rather than
// pick or type an answer. Uploads go through the same presigned-S3 pipeline
// ChatInput.tsx's attachments use (uploadToS3 in useFileUpload.ts) — files
// land in the same place regular chat attachments do.

import { useRef, useState } from 'react';
import { UploadCloud, X, Loader2, ArrowUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { uploadToS3 } from './useFileUpload';
import { UploadRequest } from './types';

interface PendingFile {
    file: File;
    fileId?: string;
    status: 'uploading' | 'done' | 'error';
}

interface UploadRequestCardProps {
    request: UploadRequest;
    onAnswer: (answer: { files: { fileId: string; name: string; type: string }[]; freeText?: string; skipped?: boolean }) => Promise<boolean>;
}

export function UploadRequestCard({ request, onAnswer }: UploadRequestCardProps) {
    const [pending, setPending] = useState<PendingFile[]>([]);
    const [freeText, setFreeText] = useState('');
    const [isDragging, setIsDragging] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const dragDepthRef = useRef(0);
    const fileInputRef = useRef<HTMLInputElement>(null);

    if (request.status !== 'pending') {
        const summary = request.status === 'expired'
            ? 'Expired — the assistant moved on'
            : request.status === 'skipped'
                ? 'Skipped'
                : (request.files?.length ? `${request.files.length} file${request.files.length === 1 ? '' : 's'} uploaded` : (request.freeText || 'Skipped'));
        return (
            <div className="flex w-full justify-center my-5">
                <div className="w-full max-w-3xl flex flex-col gap-1.5 rounded-4xl border border-border/60 bg-card shadow-elevated p-[14px]">
                    <div className="text-sm font-medium px-1">{request.prompt}</div>
                    <div className="text-sm text-muted-foreground px-1">{summary}</div>
                </div>
            </div>
        );
    }

    const addFiles = async (files: File[]) => {
        const room = request.maxFiles - pending.filter(p => p.status !== 'error').length;
        if (room <= 0) {
            toast.error(`You can upload up to ${request.maxFiles} file${request.maxFiles === 1 ? '' : 's'}`);
            return;
        }
        const toAdd = files.slice(0, room);
        const entries: PendingFile[] = toAdd.map(file => ({ file, status: 'uploading' }));
        setPending(prev => [...prev, ...entries]);

        await Promise.all(entries.map(async (entry) => {
            try {
                const fileId = await uploadToS3(entry.file, entry.file.name, entry.file.type, entry.file.size);
                setPending(prev => prev.map(p => p.file === entry.file ? { ...p, fileId, status: 'done' } : p));
            } catch {
                toast.error(`Failed to upload ${entry.file.name}`);
                setPending(prev => prev.map(p => p.file === entry.file ? { ...p, status: 'error' } : p));
            }
        }));
    };

    const removeFile = (file: File) => setPending(prev => prev.filter(p => p.file !== file));

    const uploadedFiles = pending.filter(p => p.status === 'done' && p.fileId);
    const isUploading = pending.some(p => p.status === 'uploading');
    const canSubmit = !isSubmitting && !isUploading && uploadedFiles.length >= request.minFiles;

    const submit = async () => {
        setIsSubmitting(true);
        const ok = await onAnswer({
            files: uploadedFiles.map(p => ({ fileId: p.fileId!, name: p.file.name, type: p.file.type })),
            ...(freeText.trim() ? { freeText: freeText.trim() } : {}),
        });
        setIsSubmitting(false);
        if (!ok) toast.error('Could not submit your upload. Please try again.');
    };

    const handleSkip = async () => {
        setIsSubmitting(true);
        const ok = await onAnswer({ files: [], skipped: true, ...(freeText.trim() ? { freeText: freeText.trim() } : {}) });
        setIsSubmitting(false);
        if (!ok) toast.error('Could not skip this. Please try again.');
    };

    return (
        <div className="flex w-full justify-center my-5">
            <div className="w-full max-w-3xl flex flex-col gap-4 rounded-4xl border border-primary/40 bg-card shadow-elevated p-[14px] animate-in fade-in slide-in-from-bottom-2 duration-300">
                <h4 className="text-sm font-medium px-1">{request.prompt}</h4>

                <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); }}
                    onDragEnter={(e) => { e.preventDefault(); dragDepthRef.current += 1; setIsDragging(true); }}
                    onDragLeave={(e) => {
                        e.preventDefault();
                        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
                        if (dragDepthRef.current === 0) setIsDragging(false);
                    }}
                    onDrop={(e) => {
                        e.preventDefault();
                        dragDepthRef.current = 0;
                        setIsDragging(false);
                        void addFiles(Array.from(e.dataTransfer.files));
                    }}
                    className={cn(
                        "rounded-2xl border border-dashed px-4 py-8 flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors",
                        isDragging ? "border-primary bg-primary/5" : "border-border/60 hover:bg-accent/40",
                    )}
                >
                    <div className="h-9 w-9 rounded-full bg-accent flex items-center justify-center text-muted-foreground">
                        <UploadCloud className="h-4 w-4" />
                    </div>
                    <div className="text-sm text-muted-foreground">Drag & Drop or Click to upload</div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple={request.maxFiles > 1}
                        className="hidden"
                        onChange={(e) => {
                            if (e.target.files) void addFiles(Array.from(e.target.files));
                            e.target.value = '';
                        }}
                    />
                </div>

                {pending.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                        {pending.map((p, i) => (
                            <div key={i} className="flex items-center justify-between rounded-xl bg-accent/40 px-3 py-2 text-sm">
                                <span className="truncate">{p.file.name}</span>
                                {p.status === 'uploading' && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />}
                                {p.status === 'error' && <span className="text-xs text-destructive shrink-0">Failed</span>}
                                {p.status === 'done' && (
                                    <button type="button" onClick={() => removeFile(p.file)} className="text-muted-foreground hover:text-foreground shrink-0">
                                        <X className="h-3.5 w-3.5" />
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                )}

                <div className="border-t border-border/40 pt-4 flex items-end gap-2">
                    <Textarea
                        value={freeText}
                        onChange={(e) => setFreeText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                if (freeText.trim() && uploadedFiles.length === 0) handleSkip();
                                else if (canSubmit) submit();
                                return;
                            }
                            if (e.key === 'Escape' && !freeText.trim()) {
                                e.preventDefault();
                                handleSkip();
                            }
                        }}
                        placeholder="No, and tell what to do differently"
                        rows={1}
                        className="flex-1 min-h-0 max-h-[160px] py-1.5 px-0 resize-none border-0 bg-transparent dark:bg-transparent rounded-none focus-visible:ring-0 focus-visible:ring-offset-0 text-sm shadow-none placeholder:text-muted-foreground/60"
                    />
                    <div className="flex items-center gap-2 shrink-0 pb-1.5">
                        {freeText.trim() && uploadedFiles.length === 0 ? (
                            <button
                                type="button"
                                onClick={handleSkip}
                                disabled={isSubmitting}
                                aria-label="Send"
                                className="h-8 w-8 rounded-full shrink-0 bg-primary text-primary-foreground disabled:opacity-40 flex items-center justify-center"
                            >
                                <ArrowUp className="h-4 w-4" />
                            </button>
                        ) : (
                            <>
                                <button type="button" onClick={handleSkip} disabled={isSubmitting} className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-40">
                                    <span>Skip</span>
                                    <kbd className="text-[10px] leading-none px-1.5 py-1 rounded bg-accent text-muted-foreground/70 font-mono">ESC</kbd>
                                </button>
                                <button
                                    type="button"
                                    onClick={submit}
                                    disabled={!canSubmit}
                                    className="h-8 px-4 rounded-full text-xs font-medium bg-primary text-primary-foreground disabled:opacity-40"
                                >
                                    Submit
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
