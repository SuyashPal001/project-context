import type { Metadata } from "next";
import Link from "next/link";

const BASE_URL = "https://projectcontext.co";
const CANONICAL = "/use-cases/ai-engineering-team";
const TITLE = "AI Engineering Team — Multi-Agent AI for Software Development";
const DESCRIPTION =
  "OlmoWorks gives your team a coordinated AI engineering team: Product Manager, Analyst, Project Manager, Tech Lead, and Architect — five specialists that plan, write, and execute alongside your engineers.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: CANONICAL },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${BASE_URL}${CANONICAL}`,
  },
  keywords: [
    "AI engineering team",
    "multi-agent AI development",
    "AI software development team",
    "AI development team",
    "agentic software development",
    "AI product manager",
    "AI tech lead",
    "AI software architect",
    "AI for engineering teams",
    "AI development workspace",
  ],
};

const agents = [
  {
    role: "supervisor",
    name: "Product Manager",
    focus: "Discovery + vision",
    body: "Captures your intent, asks the one clarifying question that matters, loads product context, and orchestrates the team. Every run starts here.",
  },
  {
    role: "agent",
    name: "Analyst",
    focus: "PRDs + requirements",
    body: "Writes complete PRDs — problem, goals, user stories, functional and non-functional requirements, success metrics. Edits surgically on feedback. Auto-saves.",
  },
  {
    role: "supervisor",
    name: "Project Manager",
    focus: "Roadmap + milestones",
    body: "Sequences 3–7 milestones from an approved PRD — with priorities, target dates, and dependencies. Refuses to plan from an unapproved spec.",
  },
  {
    role: "agent",
    name: "Tech Lead",
    focus: "Task breakdown",
    body: "Breaks each milestone into 3–7 tasks with acceptance criteria, effort estimates, and priorities. Tasks land on your board, ready to assign.",
  },
  {
    role: "agent",
    name: "Architect",
    focus: "Codebase expert",
    body: "Indexes your repositories and answers architecture questions with file citations. Never bluffs — says 'I don't know' when it doesn't have the answer.",
  },
];

const differentiators = [
  { title: "Coordinated, not isolated", body: "Each agent hands off to the next. PM to Analyst. Analyst (approved) to Project Manager. Project Manager to Tech Lead. The workflow is deterministic and connected." },
  { title: "Human gates at every phase", body: "You approve the PRD before planning starts. You approve milestones before tasks are created. AI drafts, humans decide — every time." },
  { title: "Grounded in your knowledge", body: "Upload documentation, index your codebase. Agents retrieve before they write. The Architect cites the actual file. No hallucinated APIs or invented file paths." },
  { title: "Persistent memory", body: "Agents remember what they've worked on. Pick up a conversation started last week. The team keeps context — you don't have to re-explain." },
  { title: "Every output scored", body: "PRDs are scored for completeness. Roadmaps for coverage. Tasks for clarity. The team improves measurably over time." },
  { title: "Smart model routing", body: "Fast, lightweight chat for quick questions. Extended-thinking models for deep planning. Depth where it counts, speed where it doesn't." },
];

const faqs = [
  {
    q: "What is an AI engineering team?",
    a: "An AI engineering team is a set of coordinated AI agents, each with a distinct role, that works alongside your human engineers to handle product planning, requirements writing, project management, and architecture decisions. OlmoWorks provides five specialists: Product Manager, Analyst, Project Manager, Tech Lead, and Architect.",
  },
  {
    q: "How is OlmoWorks different from a single AI assistant like ChatGPT or GitHub Copilot?",
    a: "OlmoWorks is a multi-agent team, not a single assistant. Each specialist runs a deterministic workflow tailored to its role. Outputs are artifacts — PRDs, roadmaps, task boards — not chat transcripts. Agents are grounded in your actual knowledge base and codebase. Human approval gates control every phase transition. And outputs are scored for quality, so the team improves over time.",
  },
  {
    q: "Does the AI engineering team integrate with my existing tools?",
    a: "OlmoWorks has MCP integrations with GitHub, Jira, Gmail, Google Workspace, and Zoho. The task board is built in. The codebase indexer connects to your repositories. Additional integrations can be added via the MCP server.",
  },
  {
    q: "Is OlmoWorks suitable for small engineering teams?",
    a: "Yes. OlmoWorks is designed for engineering teams of any size. A solo founder gets a full planning and architecture team. A 5-person team gets the bandwidth of a much larger org without the coordination overhead. Agents are available immediately, with no onboarding or ramp-up.",
  },
  {
    q: "Which AI models power OlmoWorks?",
    a: "OlmoWorks routes to the appropriate model for each task. Fast, lightweight models handle real-time chat and quick lookups. Extended-thinking models handle PRD writing, milestone sequencing, and complex architecture questions. The routing is automatic — you don't configure it.",
  },
  {
    q: "How does the AI Architect agent work?",
    a: "The Architect agent indexes your codebase — migrations, routes, tests, configuration files — and stores it in a vector knowledge base. When you ask an architecture question, it retrieves the relevant files before answering and cites the specific file and section. It says 'I don't know' when the answer isn't in the codebase rather than guessing.",
  },
];

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebPage",
      "@id": `${BASE_URL}${CANONICAL}`,
      url: `${BASE_URL}${CANONICAL}`,
      name: TITLE,
      description: DESCRIPTION,
      isPartOf: { "@id": `${BASE_URL}/#website` },
    },
    {
      "@type": "FAQPage",
      mainEntity: faqs.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

export default function AIEngineeringTeamPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 pt-32 pb-20">
        <div className="max-w-3xl">
          <span className="eyebrow">AI engineering team</span>
          <h1 className="mt-6 font-display text-[clamp(2.8rem,7vw,6rem)] leading-[0.95] tracking-tight">
            Five AI specialists.
            <br />
            <em className="italic text-[var(--mk-accent)]">One coordinated team.</em>
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
            OlmoWorks gives your engineering team a built-in AI crew — a
            Product Manager, Analyst, Project Manager, Tech Lead, and Architect
            — that plan, write, and execute alongside you. Not a chatbot. A team.
          </p>
          <div className="mt-10 flex flex-col gap-4 sm:flex-row sm:items-center">
            <Link
              href="/auth/signup"
              className="inline-block border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 py-3 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-black transition-opacity hover:opacity-90"
            >
              bring the team online →
            </Link>
            <Link
              href="/use-cases"
              className="font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)] transition-colors hover:text-[var(--mk-fg)]"
            >
              ← all use cases
            </Link>
          </div>
        </div>
      </section>

      {/* The roster */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="marketing-rule mb-16" />
        <span className="eyebrow">the roster</span>
        <h2 className="mt-6 font-display text-4xl leading-tight sm:text-5xl">
          Meet the team.
        </h2>
        <div className="mt-16 grid gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-6">
          {agents.map((a, i) => (
            <div
              key={a.name}
              className={`flex flex-col bg-[var(--mk-bg)] p-8 lg:col-span-2 ${
                i === 3 ? "lg:col-start-2" : i === 4 ? "lg:col-start-4" : ""
              }`}
            >
              {a.role === "supervisor" ? (
                <div className="mb-3 flex items-center gap-1.5">
                  <span className="h-1 w-1 rounded-full bg-[var(--mk-accent)]" />
                  <span className="font-mono-mk text-[10px] uppercase tracking-[0.22em] text-[var(--mk-accent)]">supervisor</span>
                </div>
              ) : (
                <div className="mb-3 font-mono-mk text-[10px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">agent</div>
              )}
              <h3 className="font-display text-3xl leading-tight">{a.name}</h3>
              <div className="mt-1 font-mono-mk text-xs text-[var(--mk-muted)]">{a.focus}</div>
              <p className="mt-5 flex-1 text-sm leading-relaxed text-[var(--mk-muted)]">{a.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* What makes it different */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="marketing-rule mb-16" />
        <span className="eyebrow">why it's different</span>
        <h2 className="mt-6 font-display text-4xl leading-tight sm:text-5xl">
          A process, not a prompt.
          <br />
          <em className="italic text-[var(--mk-accent)]">A team, not a tool.</em>
        </h2>
        <div className="mt-16 grid gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-2 lg:grid-cols-3">
          {differentiators.map((d) => (
            <div key={d.title} className="bg-[var(--mk-bg)] p-8">
              <h3 className="font-display text-xl leading-tight">{d.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-[var(--mk-muted)]">{d.body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="marketing-rule mb-16" />
        <span className="eyebrow">faq</span>
        <h2 className="mt-6 font-display text-4xl leading-tight sm:text-5xl">
          Common questions.
        </h2>
        <div className="mt-12 divide-y divide-[var(--mk-line)] border border-[var(--mk-line)]">
          {faqs.map((f) => (
            <div key={f.q} className="px-8 py-6">
              <h3 className="font-display text-lg leading-snug">{f.q}</h3>
              <p className="mt-3 text-sm leading-relaxed text-[var(--mk-muted)]">{f.a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <div className="marketing-rule mb-16" />
        <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-display text-4xl leading-tight sm:text-5xl">
            Your team is
            <br />
            <em className="italic text-[var(--mk-accent)]">already waiting.</em>
          </h2>
          <Link
            href="/auth/signup"
            className="shrink-0 border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 py-3 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-black transition-opacity hover:opacity-90"
          >
            get started free →
          </Link>
        </div>
      </section>
    </>
  );
}
