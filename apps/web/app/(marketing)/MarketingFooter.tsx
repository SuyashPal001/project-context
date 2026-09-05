import { Sparkle } from "lucide-react";

export function MarketingFooter() {
  return (
    <footer className="border-t border-[var(--mk-line)]">
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2.5">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--mk-accent)]">
            <Sparkle className="h-3.5 w-3.5 text-[var(--mk-accent-fg)]" strokeWidth={2} fill="currentColor" />
          </span>
          <span className="font-display text-lg">Indie Mates</span>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-[var(--mk-muted)]">
          <span>© {new Date().getFullYear()}</span>
          <a href="/use-cases" className="transition-colors hover:text-[var(--mk-fg)]">Use cases</a>
          <a href="/use-cases/ai-prd-generator" className="transition-colors hover:text-[var(--mk-fg)]">AI PRD</a>
          <a href="/use-cases/ai-project-planning" className="transition-colors hover:text-[var(--mk-fg)]">AI planning</a>
          <a href="/use-cases/ai-engineering-team" className="transition-colors hover:text-[var(--mk-fg)]">AI team</a>
          <a href="/privacy" className="transition-colors hover:text-[var(--mk-fg)]">Privacy</a>
          <a href="/terms" className="transition-colors hover:text-[var(--mk-fg)]">Terms</a>
          <a href="mailto:hello@projectcontext.co" className="transition-colors hover:text-[var(--mk-fg)]">Contact</a>
        </div>
      </div>
    </footer>
  );
}
