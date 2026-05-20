"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

const run = [
  { status: "done",    agent: "Product Manager",  note: "intent captured",          time: "11ms" },
  { status: "done",    agent: "Analyst",           note: "PRD written · 14 pages",   time: "38s"  },
  { status: "done",    agent: "Project Manager",   note: "5 milestones sequenced",   time: "9s"   },
  { status: "done",    agent: "Tech Lead",         note: "23 tasks on board",        time: "14s"  },
  { status: "running", agent: "Architect",         note: "indexing codebase...",     time: ""     },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="mx-auto flex max-w-6xl flex-col items-start px-6 pt-32 pb-24 sm:pt-40 sm:pb-32">

        <div className="mk-rise mk-d-1 flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--mk-accent)] opacity-50" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--mk-accent)]" />
          </span>
          <span className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">
            v0.1 · the first engineering workspace with a full AI team built in
          </span>
        </div>

        <h1 className="mk-rise mk-d-2 mt-10 font-display text-[clamp(3rem,9vw,7.5rem)] leading-[0.95] tracking-tight">
          Your <em className="italic text-[var(--mk-accent)]">AI engineering</em> team,
          <br />
          shipping with you.
        </h1>

        <p className="mk-rise mk-d-3 mt-10 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          Turn a one-line idea into a reviewed PRD, a sequenced roadmap, and a
          board full of tasks — in an afternoon, not a quarter. The AI team
          drafts. You approve every gate.
        </p>

        <div className="mk-rise mk-d-4 mt-12 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button asChild size="lg" className="h-12 rounded-none border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 text-base font-medium text-black hover:opacity-90">
            <Link href="/auth/signup">Bring the team online →</Link>
          </Button>
          <Link href="#agents" className="font-mono-mk text-sm uppercase tracking-[0.2em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">
            meet the roster ↓
          </Link>
        </div>

        {/* Terminal block — Mastra-style live run display */}
        <div className="mk-rise mk-d-5 mt-20 w-full">
          <div className="marketing-rule mb-8" />
          <div className="flex items-center justify-between mb-4">
            <span className="font-mono-mk text-[10px] uppercase tracking-[0.24em] text-[var(--mk-muted)]">// live run</span>
            <span className="flex items-center gap-1.5 font-mono-mk text-[10px] text-[var(--mk-accent)]">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--mk-accent)] opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--mk-accent)]" />
              </span>
              running
            </span>
          </div>

          <div className="overflow-hidden border border-[var(--mk-line)]">
            {/* Window chrome */}
            <div className="flex items-center gap-2 border-b border-[var(--mk-line)] bg-[var(--mk-bg-elev)] px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-[oklch(63.7%_.237_25.331)/60%]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[oklch(76.9%_.188_70.08)/60%]" />
              <span className="h-2.5 w-2.5 rounded-full bg-[var(--mk-accent)] opacity-60" />
              <span className="ml-3 font-mono-mk text-[11px] text-[var(--mk-muted)]">saarthi — team run</span>
            </div>

            <div className="bg-[var(--mk-bg)] p-5">
              <div className="font-mono-mk text-sm">
                <span className="text-[var(--mk-accent)]">❯</span>{" "}
                <span className="text-[var(--mk-fg)]">start-team</span>{" "}
                <span className="text-[var(--mk-muted)]">--project </span>
                <span className="text-[var(--mk-accent-soft)]">&quot;user auth redesign&quot;</span>
              </div>
              <div className="mt-4 space-y-2.5">
                {run.map((l) => (
                  <div key={l.agent} className="flex items-center gap-3 font-mono-mk text-xs">
                    {l.status === "done"
                      ? <span className="w-3 text-[var(--mk-accent)]">✓</span>
                      : <span className="w-3 animate-spin text-[var(--mk-muted)]">↻</span>
                    }
                    <span className={`inline-block min-w-[160px] ${l.status === "running" ? "text-[var(--mk-fg)]" : "text-[var(--mk-muted)]"}`}>
                      {l.agent}
                    </span>
                    <span className={l.status === "running" ? "text-[var(--mk-accent)]" : "text-[var(--mk-muted)] opacity-70"}>
                      {l.note}
                    </span>
                    {l.time && (
                      <span className="ml-auto text-[var(--mk-muted)] opacity-40">{l.time}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

      </div>
    </section>
  );
}
