import { ArrowUp, Loader2, Image as ImageIcon, Plus, Video, Mic, StopCircle, Bot, Zap, Check, Sparkles, HardDrive } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Attachment } from "@/types/agent-events";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { consumePendingAttachments } from "@/lib/pendingAttachments";
import { DriveFilePicker } from "./DriveFilePicker";
import { FolderScopeChip } from "./FolderScopeChip";
import { MentionChip } from "./MentionChip";

import { useAudioRecorder } from "./useAudioRecorder";
import { useFileUpload, MAX_ATTACHMENTS_PER_MESSAGE } from "./useFileUpload";
import { AttachmentStrip } from "./AttachmentStrip";
import { RecordingBar } from "./RecordingBar";
import { FEATURE_FLAGS } from "@/lib/feature-flags";
import { SlashPalette, PaletteHandle } from "./SlashPalette";
import { MentionPalette } from "./MentionPalette";
import { ProviderIcon } from "./ProviderIcon";
import { Agent } from "../agents/types";

interface LLMProvider {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    status: 'live' | 'coming_soon';
    costPerToken: string | null;
}

// Ranks providers by costPerToken into thirds for a relative $ / $$ / $$$ badge —
// no hardcoded dollar thresholds, since costPerToken values will shift as models are
// added/removed from the picker. Providers with no costPerToken get no badge.
function costTierBadges(providers: LLMProvider[]): Map<string, string> {
    const withCost = providers
        .filter((p): p is LLMProvider & { costPerToken: string } => p.costPerToken !== null)
        .map(p => ({ id: p.id, cost: parseFloat(p.costPerToken) }))
        .sort((a, b) => a.cost - b.cost);

    const badges = new Map<string, string>();
    const n = withCost.length;
    withCost.forEach((p, i) => {
        const tier = n <= 1 ? 1 : Math.floor((i / n) * 3);
        badges.set(p.id, '$'.repeat(Math.min(tier + 1, 3)));
    });
    return badges;
}

// Keep in sync with the mimeType allowlist in
// products/agent-platform/packages/api/routes/documents.ts and
// SUPPORTED_UPLOAD_EXTENSIONS in apps/api/src/lib/agentPrompts.ts.
// A missing entry here greys the file out in the OS picker with no explanation,
// which is how a user with a zip of documents ended up asking the agent how to
// send it and being told to use WeTransfer.
const DOCUMENT_ACCEPT = [
    "application/pdf", ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx",
    "text/plain", ".txt",
    "text/csv", ".csv",
    "application/zip", "application/x-zip-compressed", ".zip",
].join(",");

const DOCUMENT_MIME_TYPES = new Set([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/csv",
    // Windows reports a .csv as an Excel type; the picker accepts it on the
    // ".csv" extension above, but a drag-drop only ever sees the MIME.
    "application/vnd.ms-excel",
    "application/zip",
    "application/x-zip-compressed",
]);

function isDroppableFile(file: File): boolean {
    return file.type.startsWith("image/")
        || file.type.startsWith("video/")
        || file.type.startsWith("audio/")
        || DOCUMENT_MIME_TYPES.has(file.type);
}

interface ChatInputProps {
    onSend: (content: string, attachments?: Attachment[]) => void;
    onStop?: () => void;
    onVoiceClick?: () => void;
    onMediaClick?: (type: 'image' | 'video' | 'audio' | 'document') => void;
    disabled?: boolean;
    isLoading?: boolean;
    isStreaming?: boolean;
    llmProviderId?: string | null;
    providers?: LLMProvider[];
    onModelChange?: (providerId: string) => void;
    prefill?: string;
    /** Folder this conversation's agent may read, if one was granted from Drive. */
    folderPrefix?: string;
    onRevokeFolder?: () => void;
    isRevokingFolder?: boolean;
}

export function ChatInput({
    onSend,
    onStop,
    onMediaClick,
    disabled,
    isLoading,
    isStreaming,
    llmProviderId,
    providers,
    onModelChange,
    prefill,
    folderPrefix,
    onRevokeFolder,
    isRevokingFolder,
}: ChatInputProps) {
    const [content, setContent] = useState("");
    const [paletteMode, setPaletteMode] = useState<'slash' | 'mention' | null>(null);
    const [paletteQuery, setPaletteQuery] = useState('');
    // Character range in `content` covered by the trigger (e.g. "/foo" or "@bar"),
    // captured at the moment it was typed. Used to splice the selection back into
    // whatever `content` looks like at click time, since content can keep changing
    // while the palette is open — re-deriving the range from a fresh regex match
    // against the *current* content at select time only works if the trigger is
    // still the last thing in the string, which breaks for multi-line drafts or
    // trailing text.
    const [paletteRange, setPaletteRange] = useState<{ start: number; end: number } | null>(null);
    const [isDraggingFile, setIsDraggingFile] = useState(false);
    // Agents picked via "@" — rendered as removable chips instead of woven into
    // `content`, then re-serialized back into "@Name" text at send time so the
    // wire format (and whatever downstream reads it) is unchanged.
    const [mentionedAgents, setMentionedAgents] = useState<Agent[]>([]);

    const recorder = useAudioRecorder();
    const uploader = useFileUpload();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [drivePickerOpen, setDrivePickerOpen] = useState(false);
    const uploadTypeRef = useRef<'image' | 'video' | 'audio' | 'document' | null>(null);
    const paletteRef = useRef<PaletteHandle>(null);
    // dragenter/dragleave fire on every child element as the pointer crosses them,
    // so a plain boolean flickers the overlay off while dragging over nested
    // elements — a depth counter only reaches zero when the pointer truly leaves
    // the drop zone.
    const dragDepthRef = useRef(0);

    const handleSend = async () => {
        if (isStreaming) {
            onStop?.();
            return;
        }

        // Mention chips aren't part of `content` — re-serialize them back into
        // the "@Name" text the backend/agent prompt already knows how to read,
        // so switching to chip UI doesn't change the wire format.
        const mentionPrefix = mentionedAgents.map(a => `@${a.name}`).join(' ');
        const contentWithMentions = [mentionPrefix, content.trim()].filter(Boolean).join(' ');

        if (recorder.audioPreview) {
            try {
                const voiceAttachment = await uploader.uploadAudio(
                    recorder.audioPreview.blob,
                    recorder.audioPreview.url,
                );
                onSend(contentWithMentions, [...uploader.attachments, voiceAttachment]);
                setContent("");
                setMentionedAgents([]);
                uploader.clearAttachments();
                recorder.clearPreview();
            } catch (err) {
                console.error("Audio upload error:", err);
                toast.error("Failed to upload audio message");
            }
            return;
        }

        if ((!content.trim() && mentionedAgents.length === 0 && uploader.attachments.length === 0) || disabled || isLoading || uploader.isUploading) return;

        onSend(contentWithMentions, uploader.attachments.length > 0 ? uploader.attachments : undefined);
        setContent("");
        setMentionedAgents([]);
        uploader.clearAttachments();
        // Safety net: a send can happen with a palette still open (e.g. the Send
        // button clicked directly instead of Enter). Never leave a stale palette
        // floating over a now-empty input.
        setPaletteMode(null);
        setPaletteQuery('');
        setPaletteRange(null);
    };

    const handleMediaClick = (type: 'image' | 'video' | 'audio' | 'document') => {
        if (uploader.isUploading) return;
        uploadTypeRef.current = type;
        fileInputRef.current?.click();
        onMediaClick?.(type);
    };

    const handleUseEmployee = () => {
        // No typed trigger to anchor to here, so the insertion point is an empty
        // range at the current cursor (or end of content if we can't read a
        // selection) — onSelect below still needs a non-null paletteRange or it
        // silently no-ops.
        const cursor = textareaRef.current?.selectionStart ?? content.length;
        setPaletteMode('slash');
        setPaletteQuery('');
        setPaletteRange({ start: cursor, end: cursor });
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        await uploader.handleFileChange(e, fileInputRef);
        uploadTypeRef.current = null;
    };

    const handleDragEnter = (e: React.DragEvent) => {
        if (!FEATURE_FLAGS.chatUpload || uploader.isUploading) return;
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        dragDepthRef.current += 1;
        setIsDraggingFile(true);
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!FEATURE_FLAGS.chatUpload || uploader.isUploading) return;
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
    };

    const handleDragLeave = (e: React.DragEvent) => {
        if (!FEATURE_FLAGS.chatUpload) return;
        e.preventDefault();
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setIsDraggingFile(false);
    };

    const handleDrop = async (e: React.DragEvent) => {
        if (!FEATURE_FLAGS.chatUpload) return;
        e.preventDefault();
        dragDepthRef.current = 0;
        setIsDraggingFile(false);
        if (uploader.isUploading) return;

        const files = Array.from(e.dataTransfer.files);
        if (files.length === 0) return;
        if (files.length > 1) {
            toast.error("Drop one file at a time");
            return;
        }

        const [file] = files;
        if (!isDroppableFile(file)) {
            toast.error(`Unsupported file type: ${file.type || file.name}`);
            return;
        }

        await uploader.uploadFile(file);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (paletteMode) {
            if (e.key === "ArrowDown") {
                e.preventDefault();
                paletteRef.current?.moveActive(1);
                return;
            }
            if (e.key === "ArrowUp") {
                e.preventDefault();
                paletteRef.current?.moveActive(-1);
                return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Enter selects the highlighted item when the palette has one; with
                // no items (still loading, or nothing matches the query) it falls
                // back to just closing instead of sending the raw "/foo" or "@bar"
                // trigger text as a chat message.
                const selected = paletteRef.current?.selectActive();
                if (!selected) {
                    setPaletteMode(null);
                    setPaletteQuery('');
                    setPaletteRange(null);
                }
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                setPaletteMode(null);
                setPaletteQuery('');
                setPaletteRange(null);
                return;
            }
        }
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    useEffect(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "inherit";
            const scrollHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = `${Math.min(scrollHeight, 200)}px`;
        }
    }, [content]);

    useEffect(() => {
        if (prefill) {
            setContent(prefill);
            textareaRef.current?.focus();
        }
    }, [prefill]);

    useEffect(() => {
        (window as any).__addComposeAttachment = uploader.addAttachment;
        return () => { delete (window as any).__addComposeAttachment; };
    }, [uploader.addAttachment]);

    // Files chosen in Drive and handed over via "Start session".
    useEffect(() => {
        const staged = consumePendingAttachments();
        if (staged.length > 0) uploader.addAttachments(staged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const showRecordingBar = recorder.isRecording || recorder.audioPreview;

    return (
        <div className="pb-6 pt-2 px-4 bg-transparent w-full">
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                multiple
                accept={
                    uploadTypeRef.current === 'video' ? "video/*" :
                    uploadTypeRef.current === 'audio' ? "audio/*" :
                    uploadTypeRef.current === 'document' ? DOCUMENT_ACCEPT :
                    `image/*,video/*,audio/*,${DOCUMENT_ACCEPT}`
                }
                onChange={handleFileChange}
            />

            <DriveFilePicker
                open={drivePickerOpen}
                onOpenChange={setDrivePickerOpen}
                remainingSlots={Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - uploader.attachments.length)}
                onConfirm={uploader.addAttachments}
            />

            <div className="relative max-w-3xl mx-auto w-full">
                {paletteMode === 'slash' && (
                    <SlashPalette
                        ref={paletteRef}
                        query={paletteQuery}
                        onSelect={(agent: Agent) => {
                            setContent(c => {
                                if (!paletteRange) return c;
                                return c.slice(0, paletteRange.start) + `@${agent.name} ` + c.slice(paletteRange.end);
                            });
                        }}
                        onClose={() => {
                            setPaletteMode(null);
                            setPaletteQuery('');
                            setPaletteRange(null);
                        }}
                    />
                )}
                {paletteMode === 'mention' && (
                    <MentionPalette
                        ref={paletteRef}
                        query={paletteQuery}
                        onSelect={(agent: Agent) => {
                            // Remove the typed "@query" trigger text — the pick becomes a
                            // chip below, not text inside the draft.
                            setContent(c => {
                                if (!paletteRange) return c;
                                return c.slice(0, paletteRange.start) + c.slice(paletteRange.end);
                            });
                            setMentionedAgents(prev => prev.some(a => a.id === agent.id) ? prev : [...prev, agent]);
                            // The palette owns its own search input (focus lives there, not
                            // the textarea, while it's open) — hand focus back once a pick is made.
                            textareaRef.current?.focus();
                        }}
                        onClose={() => {
                            setPaletteMode(null);
                            setPaletteQuery('');
                            setPaletteRange(null);
                            textareaRef.current?.focus();
                        }}
                    />
                )}

                <div
                    className={cn(
                        "relative flex flex-col rounded-[28px] border bg-card transition-colors shadow-elevated overflow-hidden",
                        isDraggingFile ? "border-primary/60" : "border-border/60 focus-within:border-primary/30",
                    )}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    {isDraggingFile && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center rounded-[28px] bg-primary/5 backdrop-blur-[1px] pointer-events-none">
                            <span className="text-sm font-medium text-primary">Drop to attach</span>
                        </div>
                    )}

                    {/* Above the attachments, and rendered here rather than at each
                        call site: the page has three ChatInput branches and the chip
                        was originally added to only one of them — the branch a
                        brand-new conversation never takes, which is exactly the
                        Drive → New session flow the grant exists for. */}
                    {folderPrefix && onRevokeFolder && (
                        <div className="px-4 pt-3">
                            <FolderScopeChip
                                prefix={folderPrefix}
                                onRevoke={onRevokeFolder}
                                isRevoking={isRevokingFolder}
                            />
                        </div>
                    )}

                    {mentionedAgents.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
                            {mentionedAgents.map(agent => (
                                <MentionChip
                                    key={agent.id}
                                    agent={agent}
                                    onRemove={() => setMentionedAgents(prev => prev.filter(a => a.id !== agent.id))}
                                />
                            ))}
                        </div>
                    )}

                    <AttachmentStrip
                        attachments={uploader.attachments}
                        pendingUpload={uploader.pendingUpload}
                        onRemove={uploader.removeAttachment}
                    />

                    {showRecordingBar ? (
                        <RecordingBar
                            isRecording={recorder.isRecording}
                            isUploading={uploader.isUploading}
                            recordingTime={recorder.recordingTime}
                            audioPreview={recorder.audioPreview}
                            streamRef={recorder.streamRef}
                            onCancel={recorder.cancelRecording}
                            onStop={recorder.stopRecording}
                            onSend={handleSend}
                        />
                    ) : (
                        <>
                            <Textarea
                                ref={textareaRef}
                                value={content}
                                onChange={(e) => {
                                    const value = e.target.value;
                                    setContent(value);
                                    const cursor = e.target.selectionStart ?? value.length;
                                    const upToCursor = value.slice(0, cursor);
                                    const slashMatch = upToCursor.match(/(?:^|\s)\/(\w*)$/);
                                    const mentionMatch = upToCursor.match(/(?:^|\s)@(\w*)$/);
                                    if (slashMatch) {
                                        const query = slashMatch[1];
                                        setPaletteMode('slash');
                                        setPaletteQuery(query);
                                        // The matched trigger ("/" + query) always ends exactly at the
                                        // cursor, regardless of any leading whitespace the (?:^|\s)
                                        // branch consumed — so its start is just cursor minus its own
                                        // length, independent of match.index quirks.
                                        setPaletteRange({ start: cursor - 1 - query.length, end: cursor });
                                    } else if (mentionMatch) {
                                        const query = mentionMatch[1];
                                        setPaletteMode('mention');
                                        setPaletteQuery(query);
                                        setPaletteRange({ start: cursor - 1 - query.length, end: cursor });
                                    } else {
                                        setPaletteMode(null);
                                        setPaletteQuery('');
                                        setPaletteRange(null);
                                    }
                                }}
                                onKeyDown={handleKeyDown}
                                placeholder="Ask anything, @ to mention, / for workflows..."
                                className="w-full min-h-[64px] max-h-[200px] py-4 px-4 resize-none border-0 bg-transparent dark:bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-sm shadow-none placeholder:text-muted-foreground/50 caret-primary"
                                disabled={disabled}
                            />

                            <div className="flex items-center justify-between px-2 pb-2">
                                <div className="flex items-center gap-0.5">
                                    {FEATURE_FLAGS.chatUpload && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors">
                                                    <Plus className="h-4 w-4" />
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent side="top" align="start" className="w-52 p-2">
                                                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Add context</div>
                                                <DropdownMenuItem onClick={() => handleMediaClick('image')} className="gap-2 cursor-pointer py-2">
                                                    <ImageIcon className="h-4 w-4" />
                                                    <span>Media</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => handleMediaClick('video')} className="hidden gap-2 cursor-pointer py-2">
                                                    <Video className="h-4 w-4" />
                                                    <span>Video</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => handleMediaClick('document')} className="gap-2 cursor-pointer py-2">
                                                    <FileText className="h-4 w-4" />
                                                    <span>Document (PDF, DOCX)</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={() => setDrivePickerOpen(true)} className="gap-2 cursor-pointer py-2">
                                                    <HardDrive className="h-4 w-4" />
                                                    <span>From Drive</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem onClick={handleUseEmployee} className="gap-2 cursor-pointer py-2">
                                                    <Bot className="h-4 w-4" />
                                                    <span>Use employee</span>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onClick={handleUseEmployee} className="gap-2 cursor-pointer py-2">
                                                    <Zap className="h-4 w-4" />
                                                    <span>Use skill</span>
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}

                                    {providers && providers.length > 0 && (
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <button
                                                    type="button"
                                                    className="h-8 px-2 flex items-center gap-1.5 rounded-full text-xs font-medium text-foreground/90 hover:text-foreground transition-colors"
                                                >
                                                    <Sparkles className="h-3.5 w-3.5 text-ring" />
                                                    {providers.find(p => p.id === llmProviderId)?.displayName ?? 'Mind'}
                                                </button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent side="top" align="start" className="w-60 p-2">
                                                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">Mind</div>
                                                {(() => {
                                                    const badges = costTierBadges(providers);
                                                    return providers.map(provider => {
                                                        const isSelected = provider.id === llmProviderId;
                                                        return (
                                                            <DropdownMenuItem
                                                                key={provider.id}
                                                                disabled={provider.status !== 'live'}
                                                                onClick={() => onModelChange?.(provider.id)}
                                                                className="flex items-center gap-2.5 cursor-pointer py-2"
                                                            >
                                                                <ProviderIcon
                                                                    provider={provider.provider}
                                                                    className={cn(
                                                                        "h-3.5 w-3.5 shrink-0",
                                                                        provider.status === 'live' ? "text-foreground/70" : "text-muted-foreground/30",
                                                                    )}
                                                                />
                                                                <span className="flex-1 truncate">{provider.displayName}</span>
                                                                {provider.status !== 'live' ? (
                                                                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                                                        Coming soon
                                                                    </span>
                                                                ) : isSelected ? (
                                                                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
                                                                ) : badges.get(provider.id) ? (
                                                                    <span className="shrink-0 text-[10px] text-muted-foreground">
                                                                        {badges.get(provider.id)}
                                                                    </span>
                                                                ) : null}
                                                            </DropdownMenuItem>
                                                        );
                                                    });
                                                })()}
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}
                                </div>

                                <div className="flex items-center gap-1.5">
                                    {FEATURE_FLAGS.chatVoice && !content.trim() && !isStreaming && !isLoading && (
                                        <button
                                            type="button"
                                            onClick={recorder.startRecording}
                                            className="h-8 w-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                        >
                                            <Mic className="h-4 w-4" />
                                        </button>
                                    )}

                                    {isStreaming ? (
                                        <button
                                            onClick={onStop}
                                            className="h-8 w-8 flex items-center justify-center rounded-full bg-foreground text-background hover:opacity-90 transition-all shadow-sm"
                                        >
                                            <StopCircle className="h-4 w-4" />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleSend}
                                            disabled={(!content.trim() && mentionedAgents.length === 0 && uploader.attachments.length === 0) || disabled || isLoading || uploader.isUploading}
                                            title="Enter to send, Shift+Enter for a new line"
                                            className={cn(
                                                "h-8 w-8 flex items-center justify-center rounded-full transition-all active:scale-95 shadow-sm",
                                                (content.trim() || mentionedAgents.length > 0 || uploader.attachments.length > 0)
                                                    ? "bg-gradient-to-br from-[#E69DB8] to-[#F2A679] text-background"
                                                    : "bg-muted text-muted-foreground opacity-40"
                                            )}
                                        >
                                            {isLoading || uploader.isUploading ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
                                            )}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </>
                    )}
                </div>

                <p className="text-[10px] text-center text-muted-foreground/70 mt-2">
                    AI can make mistakes. Please verify important information.
                </p>
            </div>
        </div>
    );
}
