import { Trash2, Square, SendHorizontal, Loader2 } from "lucide-react";
import { AudioVisualizer } from "./AudioVisualizer";
import { MessageAudioPlayer } from "./MessageAudioPlayer";
import { AudioPreview, formatRecordingTime } from "./useAudioRecorder";

interface RecordingBarProps {
    isRecording: boolean;
    isUploading: boolean;
    recordingTime: number;
    audioPreview: AudioPreview | null;
    streamRef: React.RefObject<MediaStream | null>;
    onCancel: () => void;
    onStop: () => void;
    onSend: () => void;
}

export function RecordingBar({
    isRecording,
    isUploading,
    recordingTime,
    audioPreview,
    streamRef,
    onCancel,
    onStop,
    onSend,
}: RecordingBarProps) {
    return (
        <div className="flex items-center gap-3 w-full bg-transparent px-3 py-4 animate-in fade-in zoom-in-95">
            <button
                onClick={onCancel}
                className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
            >
                <Trash2 className="h-5 w-5" />
            </button>

            <div className="flex-1 flex items-center justify-center">
                {audioPreview ? (
                    <MessageAudioPlayer
                        url={audioPreview.url}
                        durationSeconds={recordingTime}
                        variant="input"
                    />
                ) : (
                    <div className="flex items-center gap-3 w-full min-w-[240px] max-w-sm h-[48px] bg-background/50 backdrop-blur-sm border border-destructive/30 rounded-full px-2 shadow-sm select-none animate-pulse">
                        <button
                            onClick={onStop}
                            className="h-[30px] w-[30px] shadow-sm shrink-0 rounded-full bg-destructive flex items-center justify-center text-destructive-foreground transition-transform active:scale-95"
                        >
                            <Square className="h-3 w-3 fill-destructive-foreground" />
                        </button>

                        <div className="flex-1 h-6 flex items-center overflow-hidden">
                            {streamRef.current && <AudioVisualizer stream={streamRef.current} />}
                        </div>

                        <span className="text-[10px] font-mono shrink-0 w-[38px] text-right ml-1 text-destructive pr-2 font-medium">
                            {formatRecordingTime(recordingTime)}
                        </span>
                    </div>
                )}
            </div>

            <button
                onClick={onSend}
                disabled={isRecording || isUploading}
                className="h-10 w-10 shrink-0 rounded-full bg-primary flex items-center justify-center text-primary-foreground shadow-sm transition-transform active:scale-95 disabled:opacity-50"
            >
                {isUploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <SendHorizontal className="h-5 w-5" />}
            </button>
        </div>
    );
}
