import { ImageResponse } from 'next/og'
import type { NextRequest } from 'next/server'

export const runtime = 'edge'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const title = searchParams.get('title') ?? 'project context'
  const subtitle = searchParams.get('subtitle') ?? 'your AI engineering team'

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          justifyContent: 'flex-end',
          background: '#0a0a0a',
          padding: '72px 80px',
          fontFamily: 'sans-serif',
          position: 'relative',
        }}
      >
        {/* Subtle grid */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />
        {/* Glow */}
        <div
          style={{
            position: 'absolute',
            top: '-120px',
            left: '-80px',
            width: '600px',
            height: '600px',
            borderRadius: '50%',
            background: 'radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)',
          }}
        />

        {/* Logo / brand */}
        <div
          style={{
            position: 'absolute',
            top: '56px',
            left: '80px',
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
          }}
        >
          <div
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '8px',
              background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
            }}
          />
          <span style={{ color: '#ffffff', fontSize: '20px', fontWeight: 600, letterSpacing: '-0.02em' }}>
            project context
          </span>
        </div>

        {/* Main text */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', zIndex: 1 }}>
          <p
            style={{
              margin: 0,
              fontSize: '56px',
              fontWeight: 700,
              color: '#ffffff',
              lineHeight: 1.1,
              letterSpacing: '-0.03em',
              maxWidth: '900px',
            }}
          >
            {title}
          </p>
          <p
            style={{
              margin: 0,
              fontSize: '26px',
              color: 'rgba(255,255,255,0.5)',
              letterSpacing: '-0.01em',
            }}
          >
            {subtitle}
          </p>
        </div>

        {/* Bottom badge */}
        <div
          style={{
            position: 'absolute',
            bottom: '56px',
            right: '80px',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '999px',
            padding: '8px 18px',
          }}
        >
          <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: '16px' }}>projectcontext.co</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    }
  )
}
