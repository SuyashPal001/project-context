import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

export const TitleCard: React.FC<{ kicker?: string; name: string; role?: string }> = ({ kicker, name, role }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: '6%' }}>
      <div style={{ opacity, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {kicker && (
          <div style={{
            fontFamily: 'system-ui, sans-serif', fontSize: 28, fontWeight: 600, letterSpacing: 3,
            textTransform: 'uppercase', color: '#D4AF37',
          }}>{kicker}</div>
        )}
        <div style={{
          fontFamily: 'system-ui, sans-serif', fontSize: 64, fontWeight: 800, color: '#FFFFFF',
          textShadow: '0 2px 12px rgba(0,0,0,0.6)',
        }}>{name}</div>
        {role && (
          <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 32, fontWeight: 500, color: '#E6E6E6' }}>{role}</div>
        )}
        <div style={{ width: 72, height: 4, background: '#D4AF37', marginTop: 8 }} />
      </div>
    </AbsoluteFill>
  )
}
