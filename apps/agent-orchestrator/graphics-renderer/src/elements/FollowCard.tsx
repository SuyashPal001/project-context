import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

export const FollowCard: React.FC<{ handle: string; site?: string }> = ({ handle, site }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div style={{
        opacity, background: 'rgba(10,20,40,0.82)', borderRadius: 16, padding: '22px 36px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
        border: '1px solid rgba(212,175,55,0.5)',
      }}>
        <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 34, fontWeight: 800, color: '#FFFFFF' }}>{handle}</div>
        {site && <div style={{ fontFamily: 'system-ui, sans-serif', fontSize: 22, color: '#D4AF37', fontWeight: 500 }}>{site}</div>}
      </div>
    </AbsoluteFill>
  )
}
