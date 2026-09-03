const handoffs = [
  { actor: "You", type: "human", action: "Drop a goal in chat", detail: "\"We need notifications when a customer's plan is about to expire.\"" },
  { actor: "Product Manager", type: "agent", action: "Captures intent, asks one clarifying question, hands off", detail: "Loads product context and routes to the Analyst." },
  { actor: "Analyst", type: "agent", action: "Drafts a complete PRD", detail: "Problem, goals, user stories, requirements, success metrics, saved." },
  { actor: "You", type: "human", action: "Edit inline, push back, approve", detail: "Tweak a goal, sharpen a metric. The agent edits surgically, no rewrites." },
  { actor: "Project Manager", type: "agent", action: "Generates milestones from the approved PRD", detail: "3-7 milestones, sequenced, dated, prioritized." },
  { actor: "You", type: "human", action: "Reshape, reorder, approve", detail: "Move a milestone, change a date. Approval is the gate to the next phase." },
  { actor: "Tech Lead", type: "agent", action: "Breaks each milestone into board-ready tasks", detail: "Acceptance criteria, effort estimates, priorities." },
  { actor: "You + Architect", type: "mixed", action: "Build, with the codebase on tap", detail: "Ask the Architect anything. It retrieves from your code and cites the file." },
];

export function Collaboration() {
  return (
    <section className="marketing-section mx-auto max-w-6xl px-6">
      <div className="max-w-3xl">
        <h2 className="font-display text-4xl leading-[1.05] tracking-tight sm:text-6xl">
          Built for how engineers
          <br />
          <span className="font-semibold text-[var(--mk-accent)]">actually work.</span>
        </h2>
        <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          Not a chat window. Same PRDs, same plans, same board your team
          already uses, with AI specialists drafting, and you in command at
          every gate.
        </p>
      </div>

      <div className="mt-16 rounded-2xl border border-[var(--mk-line)] bg-[var(--mk-bg-elev)] px-6">
        {handoffs.map((h, i) => (
          <div
            key={i}
            className={`grid grid-cols-[80px_1fr] gap-6 py-6 sm:grid-cols-[140px_1fr_2fr] ${
              i > 0 ? "border-t border-[var(--mk-line)]" : ""
            }`}
          >
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-[var(--mk-muted)]">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span
                className={`text-xs font-medium ${
                  h.type === "human"
                    ? "text-[var(--mk-fg)]"
                    : h.type === "agent"
                      ? "text-[var(--mk-accent)]"
                      : "text-[var(--mk-accent-deep)]"
                }`}
              >
                {h.type === "human" ? "Human" : h.type === "agent" ? "Agent" : "Together"}
              </span>
            </div>
            <div className="font-display text-2xl leading-tight">{h.actor}</div>
            <div className="col-span-2 sm:col-span-1">
              <div className="text-base leading-snug">{h.action}</div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--mk-muted)]">
                {h.detail}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-16 max-w-2xl">
        <p className="font-display text-2xl leading-tight text-[var(--mk-fg)] sm:text-3xl">
          Agents do the drafting.{" "}
          <span className="font-semibold text-[var(--mk-accent)]">You hold the gates.</span>
        </p>
        <p className="mt-4 text-base leading-relaxed text-[var(--mk-muted)]">
          Approval is what moves work to the next phase, never the agent's call.
        </p>
      </div>
    </section>
  );
}
