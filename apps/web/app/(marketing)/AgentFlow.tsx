const steps = [
  { phase: "Discovery", agent: "Product Manager", role: "supervisor", out: "Intent captured" },
  { phase: "Spec",      agent: "Analyst",          role: "agent",      out: "PRD saved"       },
  { phase: "Plan",      agent: "Project Manager",  role: "supervisor", out: "Milestones live"  },
  { phase: "Build",     agent: "Tech Lead",        role: "agent",      out: "Board populated"  },
  { phase: "Ground",    agent: "Architect",        role: "agent",      out: "Cited in code"    },
];

export function AgentFlow() {
  return (
    <section id="how" className="marketing-section mx-auto max-w-6xl px-6">
      <div className="marketing-rule mb-16" />
      <div className="max-w-3xl">
        <span className="eyebrow">the flow</span>
        <h2 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-7xl">
          From a sentence
          <br />
          <em className="italic text-[var(--mk-accent)]">to a shipped roadmap.</em>
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          One thought goes in. Five agents take it from there.
        </p>
      </div>

      {/* Pipeline connector — visible on large screens */}
      <div className="mt-16 hidden items-center lg:flex">
        {steps.map((s, i) => (
          <div key={s.phase} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1.5 px-2">
              <span className="font-mono-mk text-[9px] uppercase tracking-[0.2em] text-[var(--mk-muted)]">{s.phase}</span>
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--mk-accent)]" />
            </div>
            {i < steps.length - 1 && (
              <div className="h-px flex-1 bg-[var(--mk-line-strong)]" />
            )}
          </div>
        ))}
      </div>

      <div className="mt-px grid auto-rows-fr gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-5">
        {steps.map((s, i) => (
          <div key={s.phase} className="flex flex-col bg-[var(--mk-bg-card,var(--mk-bg))] p-6 transition-colors hover:bg-[var(--mk-bg-elev)]">
            <div className="flex items-center justify-between">
              <span className="font-mono-mk text-xs text-[var(--mk-accent)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="font-mono-mk text-[10px] uppercase tracking-[0.2em] text-[var(--mk-muted)]">
                {s.phase}
              </span>
            </div>
            <div className="mt-10 flex-1">
              <div className="font-display text-2xl leading-tight">{s.agent}</div>
              <div className="mt-2 flex items-center gap-1.5">
                {s.role === "supervisor" && (
                  <span className="h-1 w-1 rounded-full bg-[var(--mk-accent)]" />
                )}
                <span className={`font-mono-mk text-[10px] uppercase tracking-[0.18em] ${
                  s.role === "supervisor" ? "text-[var(--mk-accent)]" : "text-[var(--mk-muted)]"
                }`}>
                  {s.role}
                </span>
              </div>
            </div>
            <div className="mt-6 border-t border-[var(--mk-line)] pt-4 font-mono-mk text-[11px] text-[var(--mk-accent)]">
              → {s.out}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
