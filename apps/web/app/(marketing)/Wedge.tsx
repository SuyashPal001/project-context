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
      <div className="max-w-3xl">
        <span className="eyebrow">Why now</span>
        <h2 className="mt-4 font-display text-4xl leading-[1.05] tracking-tight sm:text-6xl">
          Every AI tool covers
          <br />
          <span className="font-semibold text-[var(--mk-muted)]">one slice.</span>
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          You can ship a PRD here, a roadmap there, tasks in another app, and
          code answers somewhere else. The artifacts never talk. The context
          never compounds.
        </p>
      </div>

      <div className="mt-16 grid gap-4 sm:grid-cols-2">
        {alternatives.map((a) => (
          <div key={a.name} className="rounded-2xl border border-[var(--mk-line)] bg-[var(--mk-bg-elev)] p-8 transition-colors hover:border-[var(--mk-line-strong)]">
            <div className="flex items-baseline justify-between gap-4">
              <div className="font-display text-2xl">{a.name}</div>
              <div className="text-xs font-medium text-[var(--mk-muted)]">
                {a.covers}
              </div>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-[var(--mk-muted)]">{a.gap}</p>
          </div>
        ))}
      </div>

      <div className="relative mt-8">
        <div className="rounded-2xl border border-[var(--mk-accent)]/30 bg-gradient-to-br from-[var(--mk-bg-elev)] to-[var(--mk-bg)] p-10 sm:p-14">
          <span className="eyebrow">What we ship</span>
          <h3 className="mt-4 font-display text-3xl leading-[1.05] tracking-tight sm:text-5xl">
            One workspace.
            <br />
            <span className="font-semibold text-[var(--mk-accent)]">The whole arc.</span>
          </h3>

          <div className="mt-10 flex flex-wrap gap-2">
            {ours.map((o, i) => (
              <div
                key={o}
                className="flex items-center gap-2 rounded-full border border-[var(--mk-line-strong)] bg-[var(--mk-bg)] px-4 py-2"
              >
                <span className="text-xs font-medium text-[var(--mk-accent)]">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className="text-sm">{o}</span>
              </div>
            ))}
          </div>

          <p className="mt-10 max-w-2xl text-base leading-relaxed text-[var(--mk-muted)]">
            A full AI engineering team, product manager, analyst, project
            manager, tech lead, and codebase architect, working in{" "}
            <span className="font-semibold text-[var(--mk-fg)]">your</span> PRDs,{" "}
            <span className="font-semibold text-[var(--mk-fg)]">your</span> plans,{" "}
            <span className="font-semibold text-[var(--mk-fg)]">your</span> board. You
            approve every gate.
          </p>
        </div>
      </div>
    </section>
  );
}
