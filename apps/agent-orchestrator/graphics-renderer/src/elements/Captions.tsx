import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import { fadeOpacity } from '../fade'

// Splits on the first case-insensitive match of `keyword` so that one word or
// phrase renders in the accent colour; everything else stays white. No match
// (or no keyword given) renders the caption plain.
function splitOnKeyword(text: string, keyword?: string): [string, string, string] {
  if (!keyword) return [text, '', '']
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase())
  if (idx === -1) return [text, '', '']
  return [text.slice(0, idx), text.slice(idx, idx + keyword.length), text.slice(idx + keyword.length)]
}

export const Captions: React.FC<{ text: string; keyword?: string }> = ({ text, keyword }) => {
  const frame = useCurrentFrame()
  const { durationInFrames, fps } = useVideoConfig()
  const opacity = fadeOpacity(frame, durationInFrames, fps)
  const [before, hit, after] = splitOnKeyword(text, keyword)
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 8% 8%' }}>
      <div style={{
        opacity, fontFamily: 'system-ui, sans-serif', fontSize: 46, fontWeight: 700, textAlign: 'center',
        color: '#FFFFFF', textShadow: '0 2px 10px rgba(0,0,0,0.75)', lineHeight: 1.25, maxWidth: '85%',
      }}>
        {before}
        {hit && <span style={{ color: '#D4AF37' }}>{hit}</span>}
        {after}
      </div>
    </AbsoluteFill>
  )
}
