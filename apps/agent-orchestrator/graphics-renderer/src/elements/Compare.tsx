import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

const Card: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div style={{
    background: 'rgba(10,20,40,0.78)', borderRadius: 14, padding: '20px 24px', width: 280,
    display: 'flex', flexDirection: 'column', gap: 8, border: '1px solid rgba(212,175,55,0.35)',
  }}>
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 16, color: '#D4AF37', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1 }}>{label}</div>
    <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 26, color: '#FFFFFF', fontWeight: 700 }}>{value}</div>
  </div>
)

export const Compare: React.FC<{ left: { label: string; value: string }; right: { label: string; value: string } }> = ({ left, right }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{ opacity, display: 'flex', alignItems: 'center', gap: 28 }}>
        <Card {...left} />
        <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 28, fontWeight: 800, color: '#D4AF37' }}>or</div>
        <Card {...right} />
      </div>
    </AbsoluteFill>
  )
}
