import React from 'react'
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

// Verified by hand (consulate demo, 2026-10-14): zooming past the point where
// the full content width still fits the window cuts content off (1.7x cut
// the browser's tab row; 1.4x fit). Hard-clamp here so a caller can't ship a
// zoom that crops real content, regardless of what zoomTo it passes.
const MAX_ZOOM = 1.4

export const ScreenWalkthrough: React.FC<{ screenshotUrl: string; urlText?: string; zoomTo?: number; cursor?: { xPct: number; yPct: number } }> = ({
  screenshotUrl, urlText, zoomTo = 1.2, cursor,
}) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps, width, height } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  const clampedZoom = Math.min(zoomTo, MAX_ZOOM)
  // Zoom builds in over the first half of the beat, holds for the second half.
  const scale = interpolate(frame, [0, durationInFrames / 2], [1, clampedZoom], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
  const frameMargin = Math.round(width * 0.08)
  const barHeight = Math.round(height * 0.055)

  return (
    <AbsoluteFill style={{ opacity, justifyContent: 'center', alignItems: 'center' }}>
      <div style={{
        width: width - frameMargin * 2, height: height - frameMargin * 2, borderRadius: 14, overflow: 'hidden',
        boxShadow: '0 20px 60px rgba(0,0,0,0.5)', background: '#1A1A1A',
      }}>
        <div style={{
          height: barHeight, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
          background: '#2B2B2E', borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {['#FF5F57', '#FEBC2E', '#28C840'].map((c) => <div key={c} style={{ width: 11, height: 11, borderRadius: 6, background: c }} />)}
          </div>
          {urlText && (
            <div style={{
              flex: 1, marginLeft: 16, background: '#1F1F22', borderRadius: 6, padding: '4px 12px',
              fontFamily: 'system-ui, sans-serif', fontSize: 14, color: '#CFCFCF',
            }}>{urlText}</div>
          )}
        </div>
        <div style={{ width: '100%', height: `calc(100% - ${barHeight}px)`, overflow: 'hidden', position: 'relative' }}>
          <Img
            src={screenshotUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top', transform: `scale(${scale})`, transformOrigin: 'top center' }}
          />
          {cursor && <ClickCursor xPct={cursor.xPct} yPct={cursor.yPct} frame={frame} fps={fps} />}
        </div>
      </div>
    </AbsoluteFill>
  )
}

const ClickCursor: React.FC<{ xPct: number; yPct: number; frame: number; fps: number }> = ({ xPct, yPct, frame, fps }) => {
  const cyclePos = frame % (fps * 1.2)
  const ringScale = interpolate(cyclePos, [0, fps * 0.5], [0.4, 1.6], { extrapolateRight: 'clamp' })
  const ringOpacity = interpolate(cyclePos, [0, fps * 0.5], [0.8, 0], { extrapolateRight: 'clamp' })
  return (
    <div style={{ position: 'absolute', left: `${xPct}%`, top: `${yPct}%`, transform: 'translate(-50%, -50%)' }}>
      <div style={{
        width: 36, height: 36, borderRadius: 18, border: '3px solid #D4AF37',
        transform: `scale(${ringScale})`, opacity: ringOpacity,
      }} />
      <div style={{
        position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
        width: 10, height: 10, borderRadius: 5, background: '#D4AF37',
      }} />
    </div>
  )
}
