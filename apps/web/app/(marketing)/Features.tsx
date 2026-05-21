const agents = [
  {
    name: "Product Manager",
    title: "Discovery + vision",
    kind: "supervisor",
    body: "Captures intent, asks the one clarifying question that matters, loads the product context, and hands the brief to the Analyst. The orchestrator that keeps every phase aligned.",
    skills: ["Clarifies intent", "Holds context", "Phase-gates"],
  },
  {
    name: "Analyst",
    title: "PRDs + requirements",
    kind: "agent",
    body: "Drafts a complete PRD — problem, goals, user stories, functional + non-functional requirements, success metrics. Edits surgically when you push back. Saves every time.",
    skills: ["Writes PRDs", "Edits in place", "Auto-saves"],
  },
  {
    name: "Project Manager",
    title: "Roadmap + milestones",
    kind: "supervisor",
    body: "Turns an approved PRD into 3–7 milestones — priorities, target dates, dependencies, ordered chronologically. Refuses to plan from an unapproved spec.",
    skills: ["Milestone-sequencing", "Date-aware", "Gate-keeps"],
  },
  {
    name: "Tech Lead",
    title: "Task breakdown",
    kind: "agent",
    body: "Decomposes each milestone into 3–7 concrete tasks with acceptance criteria, effort estimates, and priorities. Tasks land on your board, ready to assign.",
    skills: ["Acceptance criteria", "Effort estimates", "Board-ready"],
  },
  {
    name: "Architect",
    title: "Codebase expert",
    kind: "agent",
    body: "Knows your migrations, routes, tests, and architectural decisions. Never answers without retrieving. Always cites the file. Says \"I don't know\" when it doesn't.",
    skills: ["Codebase-grounded", "Cites sources", "No bluffing"],
  },
];

const comingSoon = [
  { name: "Code Reviewer", role: "PR feedback" },
  { name: "Data Analyst", role: "metrics + insights" },
  { name: "ML Specialist", role: "model design" },
  { name: "QA Engineer", role: "test coverage" },
  { name: "Security Auditor", role: "threat review" },
];

const capabilities = [
  { kicker: "01", title: "Real tools, not just chat", body: "Each agent has the tools it needs to do actual work — fetch PRDs, save plans, write tasks, query knowledge, search the web. Output is artifacts, not transcripts." },
  { kicker: "02", title: "Workflows, not one-shot prompts", body: "Every specialist runs a deterministic pipeline — gather, write, format, verify. Predictable, debuggable, improves over time." },
  { kicker: "03", title: "Persistent memory", body: "Agents remember what they've worked on. The Architect has its own memory of your codebase. Conversations pick up where they left off." },
  { kicker: "04", title: "Every output is scored", body: "Built-in scorers grade PRDs for completeness, roadmaps for coverage, tasks for clarity, delegation for accuracy. The team gets better, measurably." },
  { kicker: "05", title: "Grounded in your knowledge", body: "Upload docs and index your codebase. Agents retrieve, cite sources, and refuse to bluff. If it's not in the knowledge base, they say so." },
  { kicker: "06", title: "Smart model routing", body: "Lightweight chat uses a fast model. Heavy planning uses a deeper model with extended thinking. Speed where it matters, depth where it counts." },
];

export function Features() {
  return (
    <>
      <section id="agents" className="marketing-section mx-auto max-w-6xl px-6">
        <div className="marketing-rule mb-16" />
        <div className="max-w-3xl">
          <span className="eyebrow">the roster</span>
          <h2 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-7xl">
            Five specialists.
            <br />
            <em className="italic text-[var(--mk-accent)]">One coordinated team.</em>
          </h2>
        </div>

        <div className="mt-20 grid auto-rows-fr gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-6">
          {agents.map((a, i) => (
            <div
              key={a.name}
              className={`group flex flex-col bg-[var(--mk-bg)] p-8 transition-colors hover:bg-[var(--mk-bg-elev)] lg:col-span-2 ${
                i === 3 ? "lg:col-start-2" : i === 4 ? "lg:col-start-4" : ""
              }`}
            >
              {a.kind === "supervisor" ? (
                <div className="mb-4 flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-[var(--mk-accent)]" />
                  <span className="font-mono-mk text-[10px] uppercase tracking-[0.22em] text-[var(--mk-accent)]">
                    supervisor
                  </span>
                </div>
              ) : (
                <div className="mb-4 font-mono-mk text-[10px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">
                  agent
                </div>
              )}
              <div className="font-display text-4xl leading-tight">{a.name}</div>
              <div className="mt-1 font-mono-mk text-xs text-[var(--mk-muted)]">
                {a.title}
              </div>
              <p className="mt-6 flex-1 text-sm leading-relaxed text-[var(--mk-muted)]">
                {a.body}
              </p>
              <div className="mt-6 flex flex-wrap gap-1.5">
                {a.skills.map((s) => (
                  <span
                    key={s}
                    className="border border-[var(--mk-line-strong)] px-2.5 py-1 font-mono-mk text-[10px] uppercase tracking-[0.12em] text-[var(--mk-muted)]"
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-20">
          <div className="flex items-center gap-4">
            <div className="marketing-rule flex-1" />
            <span className="font-mono-mk text-[10px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">
              joining the team
            </span>
            <div className="marketing-rule flex-1" />
          </div>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            {comingSoon.map((c) => (
              <div
                key={c.name}
                className="flex items-center gap-2 border border-dashed border-[var(--mk-line-strong)] bg-transparent px-3 py-1.5"
              >
                <span className="font-display text-sm">{c.name}</span>
                <span className="font-mono-mk text-[10px] text-[var(--mk-muted)]">
                  · {c.role}
                </span>
                <span className="font-mono-mk text-[9px] uppercase tracking-[0.2em] text-[var(--mk-accent-dim)]">
                  soon
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="capabilities" className="marketing-section mx-auto max-w-6xl px-6">
        <div className="marketing-rule mb-16" />
        <div className="max-w-3xl">
          <span className="eyebrow">under the hood</span>
          <h2 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-7xl">
            Engineering culture,
            <br />
            <em className="italic text-[var(--mk-accent)]">built into the team.</em>
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
            Specs that get reviewed. Plans that have gates. Code answers with
            citations. Every output scored. The habits of a good engineering
            org, encoded into how each agent works.
          </p>
        </div>

        <div className="mt-20 grid gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-3">
          {capabilities.map((c) => (
            <div key={c.title} className="bg-[var(--mk-bg)] p-8 transition-colors hover:bg-[var(--mk-bg-elev)]">
              <span className="font-mono-mk text-xs text-[var(--mk-accent)]">{c.kicker}</span>
              <h3 className="mt-4 font-display text-2xl leading-tight">{c.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-[var(--mk-muted)]">{c.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
