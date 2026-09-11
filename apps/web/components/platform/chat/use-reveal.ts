// Ported from mastra-ai/mastra (packages/playground-ui/src/ds/components/MarkdownRenderer/use-reveal.ts),
// Apache License 2.0 — https://github.com/mastra-ai/mastra/blob/main/LICENSE.md
import { useEffect, useMemo, useRef, useState } from 'react';

/** How much of the reply the reveal aims to be holding back, as time at the speed it is playing. */
const BUFFER_MS = 1000;

/** How long it takes to work off a buffer that is too full or too empty. */
const CORRECT_MS = 1000;

/** How long a word keeps counting towards the speed the reply is arriving at. */
const FLOW_MS = 700;

/** How long the reveal takes to adopt a new speed, so a change of pace is never a jolt. */
const EASE_MS = 400;

/** Words per second it will not go below: a short burst between two tool calls still reads briskly. */
const SLOWEST = 10;

/** Words per second it will not go past: one word a frame, all a screen can draw. */
const FASTEST = 60;

/** Words it will never fall further behind than — about five seconds at full speed. */
const MAX_LAG = 300;

interface Flow {
  /** Words per second the reply is arriving at, as an exponential average. */
  rate: number;
  at: number;
}

/** Decays what earlier words still count for, then deposits the ones that just arrived. */
function measure(flow: Flow, now: number, gained: number): number {
  const elapsed = Math.max(0, now - flow.at);
  flow.rate = flow.rate * Math.exp(-elapsed / FLOW_MS) + gained / (FLOW_MS / 1000);
  flow.at = Math.max(flow.at, now);

  return flow.rate;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Where the reveal can cut the text: before the first word, then after each one. */
function wordStops(text: string): number[] {
  const stops = [0];
  const word = /\S+/g;

  for (let match = word.exec(text); match; match = word.exec(text)) stops.push(match.index + match[0].length);

  return stops;
}

/**
 * A jitter buffer for a streamed reply, counted in words. Chunks reach the browser
 * unevenly, and drawing each one on arrival makes a reply lurch. This runs on its
 * own clock instead: a frame loop that lays down at most one word per frame,
 * playing at the speed the reply is arriving at, measured directly.
 *
 * `chasing` (returned text !== input text) is what should gate a streaming
 * cursor — it goes false the instant displayed text catches up to received
 * text, independent of any backend/network completion signal.
 */
export function useRevealedText(text: string, streaming: boolean): string {
  const [calm] = useState(prefersReducedMotion);
  const stops = useMemo(() => wordStops(text), [text]);
  const words = stops.length - 1;

  const [landed, setLanded] = useState(() => (streaming && !calm ? 0 : words));

  const shown = calm ? words : Math.min(words, Math.max(landed, words - MAX_LAG));
  if (shown !== landed) setLanded(shown);

  const chasing = shown < words;
  const goal = useRef(words);
  const cursor = useRef(shown);
  const flow = useRef<Flow>({ rate: 0, at: 0 });
  const pace = useRef(SLOWEST);

  useEffect(() => {
    measure(flow.current, performance.now(), Math.max(0, words - goal.current));
    goal.current = words;

    if (cursor.current < shown || cursor.current > words) cursor.current = shown;
  });

  useEffect(() => {
    if (!chasing) return;

    let drawn = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const elapsed = Math.max(0, now - drawn);
      drawn = Math.max(drawn, now);

      const arriving = measure(flow.current, now, 0);
      const from = cursor.current;
      const behind = goal.current - from;

      if (behind > 0) {
        const held = (arriving * BUFFER_MS) / 1000;
        const aim = Math.min(FASTEST, Math.max(SLOWEST, arriving + ((behind - held) * 1000) / CORRECT_MS));

        pace.current += (aim - pace.current) * Math.min(1, elapsed / EASE_MS);
        cursor.current = Math.min(goal.current, Math.floor(from) + 1, from + (elapsed * pace.current) / 1000);

        if (Math.floor(cursor.current) !== Math.floor(from)) setLanded(Math.floor(cursor.current));
      }

      frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
  }, [chasing]);

  if (!chasing) return text;

  return text.slice(0, stops[shown]);
}
