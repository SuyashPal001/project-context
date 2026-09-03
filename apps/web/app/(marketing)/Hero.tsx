"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

const run = [
  { status: "done",    agent: "Product Manager",  note: "Intent captured",          time: "11ms" },
  { status: "done",    agent: "Analyst",           note: "PRD written · 14 pages",   time: "38s"  },
  { status: "done",    agent: "Project Manager",   note: "5 milestones sequenced",   time: "9s"   },
  { status: "done",    agent: "Tech Lead",         note: "23 tasks on board",        time: "14s"  },
  { status: "running", agent: "Architect",         note: "Indexing your codebase…",  time: ""     },
];

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="mx-auto grid max-w-6xl gap-16 px-6 pt-24 pb-24 sm:pb-32 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-12">

        <div className="flex flex-col items-start">
          <h1 className="mk-rise mk-d-1 font-display text-[clamp(2.75rem,6vw,5.25rem)] leading-[1.02] tracking-tight">
            Your <span className="font-semibold text-[var(--mk-accent)]">AI engineering</span> team,
            shipping with you.
          </h1>

          <p className="mk-rise mk-d-2 mt-8 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
            Turn a one-line idea into a reviewed PRD, a sequenced roadmap, and a
            board full of tasks, in an afternoon, not a quarter. The AI team
            drafts. You approve every gate.
          </p>

          <div className="mk-rise mk-d-3 mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
            <Button asChild size="lg" className="h-12 rounded-full bg-[var(--mk-accent)] px-8 text-base font-medium text-[var(--mk-accent-fg)] hover:opacity-90">
              <Link href="/auth/signup">Bring the team online →</Link>
            </Button>
            <Link href="#agents" className="text-sm font-medium text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">
              Meet the roster ↓
            </Link>
          </div>
        </div>

        {/* Live-run preview — the AI team at work on a real request */}
        <div className="mk-rise mk-d-4 relative w-full">
          <div
            aria-hidden
            className="absolute -inset-6 -z-10 rounded-[2rem] bg-[radial-gradient(ellipse_at_30%_20%,var(--mk-accent-soft),transparent_65%)] opacity-70 blur-2xl"
          />
          <div className="overflow-hidden rounded-2xl border border-[var(--mk-line)] bg-[var(--mk-bg-elev)] shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
            <div className="flex items-center justify-between border-b border-[var(--mk-line)] px-6 py-4">
              <span className="text-sm font-medium text-[var(--mk-fg)]">Team run · &quot;user auth redesign&quot;</span>
              <span className="flex items-center gap-1.5 text-xs font-medium text-[var(--mk-accent)]">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--mk-accent)] opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[var(--mk-accent)]" />
                </span>
                Running
              </span>
            </div>

            <div className="p-6">
              <div className="space-y-4">
                {run.map((l) => (
                  <div key={l.agent} className="flex items-center gap-3 text-sm">
                    {l.status === "done" ? (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--mk-accent-soft)] text-[var(--mk-accent-deep)]">
                        <Check className="h-3 w-3" strokeWidth={3} />
                      </span>
                    ) : (
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                        <span className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-[var(--mk-line-strong)] border-t-[var(--mk-accent)]" />
                      </span>
                    )}
                    <span className={`inline-block min-w-[130px] font-medium ${l.status === "running" ? "text-[var(--mk-fg)]" : "text-[var(--mk-muted)]"}`}>
                      {l.agent}
                    </span>
                    <span className={l.status === "running" ? "text-[var(--mk-accent)]" : "text-[var(--mk-muted)]"}>
                      {l.note}
                    </span>
                    {l.time && (
                      <span className="ml-auto text-xs text-[var(--mk-muted)] opacity-70">{l.time}</span>
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
