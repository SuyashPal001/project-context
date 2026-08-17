import { Brain } from "lucide-react";

export function MarketingFooter() {
  return (
    <footer className="border-t border-[var(--mk-line)]">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--mk-accent)]">
            <Brain className="h-3.5 w-3.5 text-black" strokeWidth={2} />
          </span>
          <span className="font-display text-lg">project context</span>
        </div>
        <div className="flex flex-wrap gap-6 font-mono-mk text-[11px] uppercase tracking-[0.22em] text-[var(--mk-muted)]">
          <span>© {new Date().getFullYear()}</span>
          <a href="/use-cases" className="transition-colors hover:text-[var(--mk-fg)]">use cases</a>
          <a href="/use-cases/ai-prd-generator" className="transition-colors hover:text-[var(--mk-fg)]">AI PRD</a>
          <a href="/use-cases/ai-project-planning" className="transition-colors hover:text-[var(--mk-fg)]">AI planning</a>
          <a href="/use-cases/ai-engineering-team" className="transition-colors hover:text-[var(--mk-fg)]">AI team</a>
          <a href="/privacy" className="transition-colors hover:text-[var(--mk-fg)]">privacy</a>
          <a href="/terms" className="transition-colors hover:text-[var(--mk-fg)]">terms</a>
          <a href="mailto:hello@projectcontext.co" className="transition-colors hover:text-[var(--mk-fg)]">contact</a>
        </div>
      </div>
    </footer>
  );
}
