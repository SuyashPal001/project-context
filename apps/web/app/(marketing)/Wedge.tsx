const alternatives = [
  { name: "Devin · Factory", covers: "Execution only", gap: "No PM lifecycle. No artifacts. Code-only." },
  { name: "Cursor · Copilot Workspace", covers: "Code editing", gap: "Doesn't know your roadmap or your spec." },
  { name: "Linear AI · Jira AI", covers: "Task triage", gap: "Sorts work. Doesn't define it." },
  { name: "ChatPRD · Productboard AI", covers: "PRDs only", gap: "PRD ends, the workflow stops." },
];

const ours = ["PRD", "Roadmap", "Milestones", "Tasks", "Codebase context", "Approval gates"];

export function Wedge() {
  return (
    <section className="marketing-section relative mx-auto max-w-6xl px-6">
      <div className="marketing-rule mb-16" />
      <div className="max-w-3xl">
        <span className="eyebrow">why now</span>
        <h2 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-7xl">
          Every AI tool covers
          <br />
          <em className="italic text-[var(--mk-muted)]">one slice.</em>
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          You can ship a PRD here, a roadmap there, tasks in another app, and
          code answers somewhere else. The artifacts never talk. The context
          never compounds.
        </p>
      </div>

      <div className="mt-20 grid gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2">
        {alternatives.map((a) => (
          <div key={a.name} className="bg-[var(--mk-bg)] p-8 transition-colors hover:bg-[var(--mk-bg-elev)]">
            <div className="flex items-baseline justify-between gap-4">
              <div className="font-display text-2xl">{a.name}</div>
              <div className="font-mono-mk text-[10px] uppercase tracking-[0.2em] text-[var(--mk-muted)]">
                {a.covers}
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-[var(--mk-muted)]">{a.gap}</p>
          </div>
        ))}
      </div>

      <div className="relative mt-16">
        <div className="border border-[var(--mk-accent)]/40 bg-gradient-to-br from-[var(--mk-bg-elev)] to-[var(--mk-bg)] p-10 sm:p-14">
          <span className="eyebrow">what we ship</span>
          <h3 className="mt-6 font-display text-4xl leading-[0.95] tracking-tight sm:text-6xl">
            One workspace.
            <br />
            <em className="italic text-[var(--mk-accent)]">The whole arc.</em>
          </h3>

          <div className="mt-10 flex flex-wrap gap-2">
            {ours.map((o, i) => (
              <div
                key={o}
                className="flex items-center gap-2 border border-[var(--mk-line-strong)] bg-[var(--mk-bg)] px-4 py-2"
              >
                <span className="font-mono-mk text-[10px] text-[var(--mk-accent)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm">{o}</span>
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-2xl text-base leading-relaxed text-[var(--mk-muted)]">
            A full AI engineering team — product manager, analyst, project
            manager, tech lead, and codebase architect — working in{" "}
            <em className="italic text-[var(--mk-fg)]">your</em> PRDs,{" "}
            <em className="italic text-[var(--mk-fg)]">your</em> plans,{" "}
            <em className="italic text-[var(--mk-fg)]">your</em> board. You
            approve every gate.
          </p>
        </div>
      </div>
    </section>
  );
}
