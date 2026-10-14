import React from 'react'
import { Composition } from 'remotion'
import { GraphicsOverlay } from './GraphicsOverlay'
import type { GraphicsOverlayProps } from './types'

const DEFAULT_PROPS: GraphicsOverlayProps = {
  aspectRatio: '16:9',
  durationSeconds: 10,
  fps: 30,
  elements: [],
}

export const Root: React.FC = () => (
  <Composition
    id="GraphicsOverlay"
    component={GraphicsOverlay}
    durationInFrames={DEFAULT_PROPS.fps * DEFAULT_PROPS.durationSeconds}
    fps={DEFAULT_PROPS.fps}
    width={1920}
    height={1080}
    defaultProps={DEFAULT_PROPS}
    calculateMetadata={async ({ props }) => {
      const { aspectRatio, durationSeconds, fps } = props as GraphicsOverlayProps
      const [width, height] = aspectRatio === '9:16' ? [1080, 1920] : [1920, 1080]
      return { width, height, fps, durationInFrames: Math.max(1, Math.round(durationSeconds * fps)) }
    }}
  />
)
