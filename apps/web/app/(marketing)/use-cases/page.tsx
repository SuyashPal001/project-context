import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Use Cases — AI engineering team for every workflow",
  description:
    "See how OlmoWorks's AI engineering team helps with PRD writing, project planning, roadmap generation, and codebase-grounded architecture decisions.",
  alternates: { canonical: "/use-cases" },
  openGraph: {
    title: "Use Cases — OlmoWorks",
    description:
      "AI PRD generator, AI project planning, AI engineering team. See every use case for OlmoWorks.",
    url: "https://projectcontext.co/use-cases",
  },
};

const cases = [
  {
    href: "/use-cases/ai-prd-generator",
    kicker: "01",
    title: "AI PRD Generator",
    body: "Turn a one-line idea into a complete Product Requirements Document — problem statement, goals, user stories, acceptance criteria, and success metrics — in minutes.",
    tags: ["Analyst agent", "PRD writing", "Requirements"],
  },
  {
    href: "/use-cases/ai-project-planning",
    kicker: "02",
    title: "AI Project Planning",
    body: "Convert an approved PRD into a sequenced roadmap with milestones, dependencies, and target dates. Then break each milestone into board-ready tasks with effort estimates.",
    tags: ["Project Manager agent", "Tech Lead agent", "Roadmap"],
  },
  {
    href: "/use-cases/ai-engineering-team",
    kicker: "03",
    title: "AI Engineering Team",
    body: "Run a full coordinated AI team — PM, Analyst, Project Manager, Tech Lead, and Architect — that plans, writes, and executes alongside your engineers.",
    tags: ["Multi-agent", "Full workflow", "Codebase-grounded"],
  },
];

export default function UseCasesIndex() {
  return (
    <section className="mx-auto max-w-6xl px-6 pt-32 pb-24">
      <div className="max-w-3xl">
        <span className="eyebrow">use cases</span>
        <h1 className="mt-6 font-display text-5xl leading-[0.95] tracking-tight sm:text-7xl">
          One team.
          <br />
          <em className="italic text-[var(--mk-accent)]">Every workflow.</em>
        </h1>
        <p className="mt-8 max-w-xl text-lg leading-relaxed text-[var(--mk-muted)]">
          OlmoWorks's AI specialists cover every stage of the engineering
          process — from the first idea to a board full of tasks, all grounded
          in your actual codebase and knowledge base.
        </p>
      </div>

      <div className="mt-20 grid gap-px overflow-hidden border border-[var(--mk-line)] bg-[var(--mk-line)] sm:grid-cols-3">
        {cases.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group flex flex-col bg-[var(--mk-bg)] p-8 transition-colors hover:bg-[var(--mk-bg-elev)]"
          >
            <span className="font-mono-mk text-xs text-[var(--mk-accent)]">{c.kicker}</span>
            <h2 className="mt-4 font-display text-3xl leading-tight">{c.title}</h2>
            <p className="mt-4 flex-1 text-sm leading-relaxed text-[var(--mk-muted)]">{c.body}</p>
            <div className="mt-6 flex flex-wrap gap-1.5">
              {c.tags.map((t) => (
                <span
                  key={t}
                  className="border border-[var(--mk-line-strong)] px-2.5 py-1 font-mono-mk text-[10px] uppercase tracking-[0.12em] text-[var(--mk-muted)]"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-6 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-accent)] transition-opacity group-hover:opacity-100 opacity-60">
              learn more →
            </div>
          </Link>
        ))}
      </div>

      <div className="mt-16 text-center">
        <Link
          href="/auth/signup"
          className="inline-block border border-[var(--mk-accent)] bg-[var(--mk-accent)] px-8 py-3 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-black transition-opacity hover:opacity-90"
        >
          bring the team online →
        </Link>
      </div>
    </section>
  );
}
