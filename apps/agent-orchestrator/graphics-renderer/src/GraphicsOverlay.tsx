import React from 'react'
import { AbsoluteFill, Sequence, useVideoConfig } from 'remotion'
import type { GraphicsElement, GraphicsOverlayProps } from './types'
import { TitleCard } from './elements/TitleCard'
import { InfoCards } from './elements/InfoCards'
import { FollowCard } from './elements/FollowCard'
import { Captions } from './elements/Captions'
import { CornerMark } from './elements/CornerMark'
import { ScreenWalkthrough } from './elements/ScreenWalkthrough'
import { Compare } from './elements/Compare'

function renderOne(el: GraphicsElement): React.ReactElement | null {
  switch (el.type) {
    case 'title_card': return <TitleCard kicker={el.kicker} name={el.name} role={el.role} />
    case 'info_cards': return <InfoCards headline={el.headline} cards={el.cards} />
    case 'follow_card': return <FollowCard handle={el.handle} site={el.site} />
    case 'captions': return <Captions text={el.text} keyword={el.keyword} />
    case 'corner_mark': return <CornerMark text={el.text} />
    case 'screen_walkthrough': return <ScreenWalkthrough screenshotUrl={el.screenshotUrl} urlText={el.urlText} zoomTo={el.zoomTo} cursor={el.cursor} />
    case 'compare': return <Compare left={el.left} right={el.right} />
    default: return null
  }
}

// No <AbsoluteFill> background colour is ever set here — the composition
// stays transparent end to end, so the PNG sequence this renders carries
// alpha and the orchestrator's ffmpeg overlay step composites straight onto
// the presenter video (see renderGraphics.ts). Setting any background here
// would opaque the whole frame and hide the presenter.
export const GraphicsOverlay: React.FC<GraphicsOverlayProps> = ({ elements }) => {
  const { fps, durationInFrames } = useVideoConfig()
  return (
    <AbsoluteFill>
      {elements.map((el, i) => {
        const from = Math.round(el.startSeconds * fps)
        const to = Math.round(el.endSeconds * fps)
        const len = Math.max(1, Math.min(to, durationInFrames) - from)
        if (from >= durationInFrames || len <= 0) return null
        return (
          <Sequence key={i} from={from} durationInFrames={len} layout="none">
            {renderOne(el)}
          </Sequence>
        )
      })}
    </AbsoluteFill>
  )
}
