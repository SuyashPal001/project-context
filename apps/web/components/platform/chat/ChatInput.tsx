import { SendHorizontal, Loader2, Image as ImageIcon, Plus, Video, Mic, StopCircle } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { useState, useRef, useEffect } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Attachment } from "@/types/agent-events";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

import { useAudioRecorder } from "./useAudioRecorder";
import { useFileUpload } from "./useFileUpload";
import { AttachmentStrip } from "./AttachmentStrip";
import { RecordingBar } from "./RecordingBar";
import { FEATURE_FLAGS } from "@/lib/feature-flags";
import { SlashPalette } from "./SlashPalette";
import { MentionPalette } from "./MentionPalette";
import { Agent } from "../agents/types";

interface LLMProvider {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    status: 'live' | 'coming_soon';
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
    "application/zip", "application/x-zip-compressed", ".zip",
].join(",");

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
}

export function ChatInput({
    onSend,
    onStop,
    onMediaClick,
    disabled,
    isLoading,
    isStreaming,
    prefill,
}: ChatInputProps) {
    const [content, setContent] = useState("");
    const [paletteMode, setPaletteMode] = useState<'slash' | 'mention' | null>(null);
    const [paletteQuery, setPaletteQuery] = useState('');

    const recorder = useAudioRecorder();
    const uploader = useFileUpload();

    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadTypeRef = useRef<'image' | 'video' | 'audio' | 'document' | null>(null);

    const handleSend = async () => {
        if (isStreaming) {
            onStop?.();
            return;
        }

        if (recorder.audioPreview) {
            try {
                const voiceAttachment = await uploader.uploadAudio(
                    recorder.audioPreview.blob,
                    recorder.audioPreview.url,
                );
                onSend(content.trim(), [...uploader.attachments, voiceAttachment]);
                setContent("");
                uploader.clearAttachments();
                recorder.clearPreview();
            } catch (err) {
                console.error("Audio upload error:", err);
                toast.error("Failed to upload audio message");
            }
            return;
        }

        if ((!content.trim() && uploader.attachments.length === 0) || disabled || isLoading || uploader.isUploading) return;

        onSend(content.trim(), uploader.attachments.length > 0 ? uploader.attachments : undefined);
        setContent("");
        uploader.clearAttachments();
    };

    const handleMediaClick = (type: 'image' | 'video' | 'audio' | 'document') => {
        uploadTypeRef.current = type;
        fileInputRef.current?.click();
        onMediaClick?.(type);
    };

    const handleUseEmployee = () => { setPaletteMode('slash'); setPaletteQuery(''); };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        await uploader.handleFileChange(e, fileInputRef);
        uploadTypeRef.current = null;
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

    const showRecordingBar = recorder.isRecording || recorder.audioPreview;

    return (
        <div className="pb-6 pt-2 px-4 bg-transparent w-full border-t border-[#1a1a1a]">
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={
                    uploadTypeRef.current === 'video' ? "video/*" :
                    uploadTypeRef.current === 'audio' ? "audio/*" :
                    uploadTypeRef.current === 'document' ? DOCUMENT_ACCEPT :
                    `image/*,video/*,audio/*,${DOCUMENT_ACCEPT}`
                }
                onChange={handleFileChange}
            />

            <div className="max-w-3xl mx-auto w-full">
                <div className="relative flex flex-col rounded-[28px] border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">

                    {paletteMode === 'slash' && (
                        <SlashPalette
                            query={paletteQuery}
                            onSelect={(agent: Agent) => {
                                setContent(c => c.replace(/(?:^|\s)\/(\w*)$/, ` @${agent.name} `));
                            }}
                            onClose={() => setPaletteMode(null)}
                        />
                    )}
                    {paletteMode === 'mention' && (
                        <MentionPalette
                            query={paletteQuery}
                            onSelect={(label: string) => {
                                setContent(c => c.replace(/(?:^|\s)@(\w*)$/, ` @${label} `));
                            }}
                            onClose={() => setPaletteMode(null)}
                        />
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
                                        setPaletteMode('slash');
                                        setPaletteQuery(slashMatch[1]);
                                    } else if (mentionMatch) {
                                        setPaletteMode('mention');
                                        setPaletteQuery(mentionMatch[1]);
                                    } else {
                                        setPaletteMode(null);
                                    }
                                }}
                                onKeyDown={handleKeyDown}
                                placeholder="Ask anything, @ to mention, / for workflows..."
                                className="w-full min-h-[44px] max-h-[200px] py-4 px-4 resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-sm shadow-none placeholder:text-muted-foreground/50"
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
                                            <DropdownMenuContent side="top" align="start" className="w-48 p-2">
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
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    )}

                                    <button
                                        type="button"
                                        onClick={handleUseEmployee}
                                        className="h-8 px-3 flex items-center gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                                            <rect x="3" y="5" width="8" height="6" rx="1.5" stroke="currentColor" strokeWidth="1"/>
                                            <circle cx="5.5" cy="8" r="0.6" fill="currentColor"/>
                                            <circle cx="8.5" cy="8" r="0.6" fill="currentColor"/>
                                            <line x1="7" y1="5" x2="7" y2="3.2" stroke="currentColor" strokeWidth="1"/>
                                            <circle cx="7" cy="2.6" r="0.6" fill="currentColor"/>
                                        </svg>
                                        Use employee
                                    </button>
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
                                            className="h-8 w-8 flex items-center justify-center rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90 transition-all shadow-sm"
                                        >
                                            <StopCircle className="h-4 w-4" />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleSend}
                                            disabled={(!content.trim() && uploader.attachments.length === 0) || disabled || isLoading || uploader.isUploading}
                                            title="Enter to send, Shift+Enter for a new line"
                                            className={cn(
                                                "h-8 w-8 flex items-center justify-center rounded-lg transition-all active:scale-95 shadow-sm",
                                                (content.trim() || uploader.attachments.length > 0) ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground opacity-40"
                                            )}
                                        >
                                            {isLoading || uploader.isUploading ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <SendHorizontal className="h-4 w-4" />
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
