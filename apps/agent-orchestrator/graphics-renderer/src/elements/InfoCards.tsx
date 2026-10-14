import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

export const InfoCards: React.FC<{ headline: string; cards: { label: string; value: string }[] }> = ({ headline, cards }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-end', padding: '6%' }}>
      <div style={{ opacity, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 14, maxWidth: '55%' }}>
        <div style={{
          fontFamily: 'system-ui, sans-serif', fontSize: 40, fontWeight: 800, color: '#FFFFFF',
          textAlign: 'right', textShadow: '0 2px 10px rgba(0,0,0,0.6)',
        }}>{headline}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {cards.map((c, i) => (
            <div key={i} style={{
              background: 'rgba(10,20,40,0.72)', borderRadius: 10, padding: '10px 18px',
              display: 'flex', gap: 10, alignItems: 'baseline',
            }}>
              <span style={{ fontFamily: 'system-ui, sans-serif', fontSize: 18, color: '#D4AF37', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>{c.label}</span>
              <span style={{ fontFamily: 'system-ui, sans-serif', fontSize: 22, color: '#FFFFFF', fontWeight: 600 }}>{c.value}</span>
            </div>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  )
}
