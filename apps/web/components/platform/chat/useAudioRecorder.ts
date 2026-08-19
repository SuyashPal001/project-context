import { useState, useRef, useEffect, useCallback } from "react";
import { toast } from "sonner";

export interface AudioPreview {
    url: string;
    blob: Blob;
}

export function formatRecordingTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

export function useAudioRecorder() {
    const [isRecording, setIsRecording] = useState(false);
    const [recordingTime, setRecordingTime] = useState(0);
    const [audioPreview, setAudioPreview] = useState<AudioPreview | null>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const [playbackTime, setPlaybackTime] = useState(0);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const audioChunksRef = useRef<BlobPart[]>([]);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // Mirrors the latest audioPreview so the unmount cleanup sees the real URL
    // rather than the stale null captured at mount time.
    const audioPreviewRef = useRef<AudioPreview | null>(null);

    const setPreview = useCallback((next: AudioPreview | null) => {
        audioPreviewRef.current = next;
        setAudioPreview(next);
    }, []);

    useEffect(() => {
        return () => {
            if (audioPreviewRef.current) URL.revokeObjectURL(audioPreviewRef.current.url);
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
            }
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, []);

    const startRecording = async () => {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            const mediaRecorder = new MediaRecorder(stream);
            mediaRecorderRef.current = mediaRecorder;
            audioChunksRef.current = [];

            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorder.onstop = () => {
                const mimeType = MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : MediaRecorder.isTypeSupported('audio/mp4')
                        ? 'audio/mp4'
                        : 'audio/mpeg';

                // Revoke the previous take before creating a new URL so
                // record → re-record cycles don't leak one URL per take.
                if (audioPreviewRef.current) URL.revokeObjectURL(audioPreviewRef.current.url);
                const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
                const url = URL.createObjectURL(audioBlob);
                setPreview({ url, blob: audioBlob });
                if (streamRef.current) {
                    streamRef.current.getTracks().forEach(track => track.stop());
                }
            };

            mediaRecorder.start();
            setIsRecording(true);
            setRecordingTime(0);
            timerRef.current = setInterval(() => setRecordingTime(prev => prev + 1), 1000);
        } catch (err) {
            console.error(err);
            toast.error("Microphone access denied");
        }
    };

    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
            if (timerRef.current) clearInterval(timerRef.current);
        }
    };

    const cancelRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.onstop = null;
            mediaRecorderRef.current.stop();
            if (streamRef.current) {
                streamRef.current.getTracks().forEach(track => track.stop());
            }
        }
        setIsRecording(false);
        if (audioPreviewRef.current) URL.revokeObjectURL(audioPreviewRef.current.url);
        setPreview(null);
        if (timerRef.current) clearInterval(timerRef.current);
    };

    const togglePlay = () => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.pause();
        } else {
            audioRef.current.play();
        }
        setIsPlaying(!isPlaying);
    };

    const clearPreview = () => {
        if (audioPreviewRef.current) URL.revokeObjectURL(audioPreviewRef.current.url);
        setPreview(null);
    };

    return {
        isRecording,
        recordingTime,
        audioPreview,
        isPlaying,
        playbackTime,
        streamRef,
        audioRef,
        startRecording,
        stopRecording,
        cancelRecording,
        togglePlay,
        clearPreview,
    };
}
