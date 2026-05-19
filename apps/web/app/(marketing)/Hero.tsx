"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="mx-auto flex max-w-6xl flex-col items-start px-6 pt-32 pb-24 sm:pt-40 sm:pb-32">
        <div className="mk-rise mk-d-1 flex items-center gap-3">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--mk-accent)] opacity-60" />
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
          <Button asChild size="lg" className="h-12 rounded-none border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 text-base font-medium text-black hover:bg-[var(--mk-accent)]/90">
            <Link href="/auth/signup">Bring the team online →</Link>
          </Button>
          <Link href="#agents" className="font-mono-mk text-sm uppercase tracking-[0.2em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]">
            meet the roster ↓
          </Link>
        </div>

        <div className="mk-rise mk-d-5 mt-24 w-full">
          <div className="marketing-rule mb-8" />
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.24em] text-[var(--mk-muted)]">
            <span className="font-mono-mk">// your team</span>
          </div>
          <div className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-sm border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-5">
            {team.map((t) => (
              <div
                key={t.name}
                className="group flex flex-col gap-2 bg-[var(--mk-bg)] px-5 py-6 transition-colors hover:bg-[var(--mk-bg-elev)]"
              >
                <div className="flex items-center gap-2">
                  <span className="h-1 w-1 rounded-full bg-[var(--mk-accent)]" />
                  <span className="font-mono-mk text-[10px] uppercase tracking-[0.2em] text-[var(--mk-muted)]">
                    {t.tag}
                  </span>
                </div>
                <div className="font-display text-2xl leading-tight">
                  {t.name}
                </div>
                <div className="font-mono-mk text-xs text-[var(--mk-muted)]">
                  {t.role}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

const team = [
  { name: "Product Manager", tag: "01", role: "discovery + vision" },
  { name: "Analyst", tag: "02", role: "PRDs + requirements" },
  { name: "Project Manager", tag: "03", role: "roadmap + milestones" },
  { name: "Tech Lead", tag: "04", role: "task breakdown" },
  { name: "Architect", tag: "05", role: "codebase expert" },
];
