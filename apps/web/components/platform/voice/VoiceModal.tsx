'use client';

import { useEffect, useCallback } from 'react';
import { X, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VoiceOrb } from './VoiceOrb';
import { Waveform } from './Waveform';
import { TranscriptOverlay } from './TranscriptOverlay';
import type { VoiceState, VoiceSession } from './types';

interface VoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  session: VoiceSession;
  onTap: () => void; // Tap orb to toggle listening/interrupt
}

export function VoiceModal({ isOpen, onClose, session, onTap }: VoiceModalProps) {
  // Close on escape
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }

    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = '';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={cn(
      'fixed inset-0 z-50',
      'bg-gradient-to-br from-background via-primary/10 to-background',
      'flex flex-col items-center justify-center',
      'animate-in fade-in duration-300'
    )}>
      {/* Close button */}
      <button
        onClick={onClose}
        className={cn(
          'absolute top-6 right-6 p-3 rounded-full',
          'bg-white/10 hover:bg-white/20 transition-colors',
          'text-white/80 hover:text-white'
        )}
      >
        <X className="w-6 h-6" />
      </button>

      {/* Settings button */}
      <button
        className={cn(
          'absolute top-6 left-6 p-3 rounded-full',
          'bg-white/10 hover:bg-white/20 transition-colors',
          'text-white/80 hover:text-white'
        )}
      >
        <Settings className="w-6 h-6" />
      </button>

      {/* State label */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2">
        <p className={cn(
          'text-sm font-medium px-4 py-1.5 rounded-full',
          'bg-white/10 text-white/80'
        )}>
          {getStateLabel(session.state)}
        </p>
      </div>

      {/* Main orb */}
      <div className="flex-1 flex items-center justify-center">
        <VoiceOrb
          state={session.state}
          audioLevel={session.audioLevel}
          onClick={onTap}
        />
      </div>

      {/* Waveform (shown when speaking) */}
      {session.state === 'speaking' && (
        <div className="absolute bottom-48">
          <Waveform
            audioLevel={session.audioLevel}
            isActive={true}
            color="rgba(255, 255, 255, 0.6)"
          />
        </div>
      )}

      {/* Transcript overlay */}
      <TranscriptOverlay
        state={session.state}
        transcript={session.transcript}
        response={session.response}
        isVisible={true}
      />

      {/* Hint text */}
      <div className="absolute bottom-8">
        <p className="text-white/40 text-sm">
          {getHintText(session.state)}
        </p>
      </div>

      {/* Error display */}
      {session.error && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2">
          <p className="text-red-400 text-sm bg-red-400/10 px-4 py-2 rounded-lg">
            {session.error}
          </p>
        </div>
      )}
    </div>
  );
}

function getStateLabel(state: VoiceState): string {
  switch (state) {
    case 'idle': return 'Tap to speak';
    case 'listening': return 'Listening...';
    case 'thinking': return 'Thinking...';
    case 'speaking': return 'Speaking...';
    case 'error': return 'Error occurred';
  }
}

function getHintText(state: VoiceState): string {
  switch (state) {
    case 'idle': return 'Tap the orb to start talking';
    case 'listening': return 'Speak now • Tap to cancel';
    case 'thinking': return 'Processing your request...';
    case 'speaking': return 'Tap to interrupt';
    case 'error': return 'Tap to try again';
  }
}
