import React from 'react'
import { AbsoluteFill } from 'remotion'

// Stays at a constant low opacity for its whole active span — no fade, since
// this is meant to read as a persistent watermark-style mark, not a beat.
export const CornerMark: React.FC<{ text?: string }> = ({ text = 'Concept sample' }) => (
  <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-end', padding: '3%' }}>
    <div style={{
      fontFamily: 'system-ui, sans-serif', fontSize: 16, fontWeight: 500, color: 'rgba(255,255,255,0.65)',
      letterSpacing: 1, textShadow: '0 1px 4px rgba(0,0,0,0.6)',
    }}>{text}</div>
  </AbsoluteFill>
)
