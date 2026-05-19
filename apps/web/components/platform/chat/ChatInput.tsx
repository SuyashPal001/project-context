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

interface LLMProvider {
    id: string;
    provider: string;
    model: string;
    displayName: string;
    isDefault: boolean;
    status: 'live' | 'coming_soon';
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
}

export function ChatInput({
    onSend,
    onStop,
    onMediaClick,
    disabled,
    isLoading,
    isStreaming,
}: ChatInputProps) {
    const [content, setContent] = useState("");

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
                    uploadTypeRef.current === 'document' ? "application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx" :
                    "image/*,video/*,audio/*,application/pdf"
                }
                onChange={handleFileChange}
            />

            <div className="max-w-3xl mx-auto w-full">
                <div className="flex flex-col rounded-2xl border border-border/60 bg-muted/30 focus-within:border-primary/30 transition-colors shadow-sm overflow-hidden">

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
                                onChange={(e) => setContent(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder="Ask anything, @ to mention, / for workflows..."
                                className="w-full min-h-[44px] max-h-[200px] py-4 px-4 resize-none border-0 bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0 text-sm shadow-none placeholder:text-muted-foreground/50"
                                disabled={disabled}
                            />

                            <div className="flex items-center justify-between px-2 pb-2">
                                <div className="flex items-center gap-0.5">
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
                                </div>

                                <div className="flex items-center gap-1.5">
                                    {!content.trim() && !isStreaming && !isLoading && (
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

                <p className="text-[10px] text-center text-muted-foreground mt-2">
                    Shift + Enter for a new line. Press Enter to send.
                </p>
            </div>
        </div>
    );
}
